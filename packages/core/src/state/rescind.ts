// Silent-cast-rescind detection (prompts-on-the-table §5.6b). XMage 1.4.60
// rescinds a cast with no feedback of any kind when a post-announce step finds
// the proposal illegal — live-hit 2026-07-25 by Entrancing Melody at X=5,
// where the only mana-value-5 creature wore Lightning Greaves (shroud) and the
// adjusted target filter came up empty: four casts, four silent bounces.
//
// No wire signal exists, but the signature is clean and entirely client-side:
// our own spell sat on the stack while a cast-flow prompt ran, and the next
// plain-priority ask shows the stack object gone with the card back in hand —
// neither resolved nor countered. The player's own Cancel produces the same
// state, so the detector stands down when the seat's last answer was {cancel}.
//
// Source naming is best-effort under the emit-only-when-confident rule: when
// exactly one battlefield creature carries an untargetability grant (its own
// text or an attachment's), the toast names it — "Zurgo Helmsmasher has shroud
// from Lightning Greaves" — otherwise the toast stays generic. A wrong
// accusation is worse than no accusation.

import type { GameState, Id, Permanent } from '../protocol/protocol';
import type { Stores } from '../stores';
import { pushNotice } from '../stores/notices';

/** The prompt kinds a cast flow runs through between the click and the stack
 *  commit (announce X / pick targets / pay the cost). */
const CAST_FLOW = new Set(['chooseAmount', 'chooseTargets', 'payMana']);

const UNTARGETABLE = /\b(shroud|hexproof|protection from)\b/i;

interface CastWatch { stackId: Id; cardId: Id; name: string }

/** Wire the detector to the stores. Fires an info toast on a detected rescind.
 *  Returns the unsubscribe. */
export function wireRescindDetector(stores: Stores): () => void {
  let watch: CastWatch | undefined;
  let lastPromptId: number | undefined = stores.prompt.getState().pending?.promptId;

  return stores.prompt.subscribe(s => {
    const p = s.pending;
    if (p?.promptId === lastPromptId) return;   // scratch churn, not a new ask
    lastPromptId = p?.promptId;
    if (p === undefined) return;                // promptDone — the verdict needs the next ask
    const state = stores.game.getState().state;
    if (state === undefined) { watch = undefined; return; }

    if (CAST_FLOW.has(p.kind)) {
      // (Re-)arm while the flow runs: watch our own spell on top of the stack.
      const top = state.stack[state.stack.length - 1];
      if (top?.kind === 'spell' && top.controllerId === state.me.playerId && top.card !== undefined) {
        watch = { stackId: top.id, cardId: top.card.id, name: top.card.name };
      }
      return;
    }
    if (p.kind !== 'priority' || watch === undefined) return;   // confirms etc. mid-flow keep the watch

    // First priority after the flow: the verdict is in this state, decided once.
    const w = watch;
    watch = undefined;
    const stackGone = !state.stack.some(item => item.id === w.stackId);
    const backInHand = state.me.hand.some(c => c.id === w.cardId);
    if (!stackGone || !backInHand) return;      // committed (still on stack) or resolved/countered
    if (s.lastAnswer?.type === 'cancel') return; // the player backed out — nothing to explain
    const blame = culprit(state);
    pushNotice(stores.notices, 'info',
      `The server rescinded ${w.name} — likely no legal target.${blame !== undefined ? ` ${blame}.` : ''}`);
  });
}

/** Name the untargetability grantor when there is exactly one confident story
 *  on the board: a creature whose own text or attachment grants
 *  shroud/hexproof/protection. More than one candidate → undefined (generic
 *  toast beats a wrong accusation). */
export function culprit(state: GameState): string | undefined {
  const found: string[] = [];
  for (const pl of state.players) {
    const byId = new Map(pl.battlefield.map(perm => [perm.id, perm]));
    for (const perm of pl.battlefield) {
      if (!isCreature(perm)) continue;
      const own = keyword(perm.text);
      if (own !== undefined) {
        found.push(`${perm.name} has ${own}`);
        continue;
      }
      for (const attId of perm.attachments ?? []) {
        const att = byId.get(attId);
        const granted = att !== undefined ? keyword(att.text) : undefined;
        if (granted !== undefined) {
          found.push(`${perm.name} has ${granted} from ${att!.name}`);
          break;
        }
      }
    }
  }
  return found.length === 1 ? found[0] : undefined;
}

function isCreature(perm: Permanent): boolean {
  return perm.types.some(t => t.toLowerCase() === 'creature');
}

function keyword(text: string[]): string | undefined {
  for (const line of text) {
    const m = UNTARGETABLE.exec(line);
    if (m !== null) return m[1]!.toLowerCase() === 'protection from' ? 'protection' : m[1]!.toLowerCase();
  }
  return undefined;
}

// ── §5.6c: the empty ask ─────────────────────────────────────────────────────
//
// Live-found 2026-07-25 (game 4CFQPJ): XMage pre-filters illegal choices out
// of a GAME_TARGET's candidates instead of rejecting the attempt — "Select
// attacker to block" against Tasigur wearing Sword of Feast and Famine arrived
// with ZERO candidates, and no GAME_INFORM_PERSONAL fires anywhere in that
// flow. The empty ask is the only signal there is, so the client tells the
// story itself: name the blocking restriction when the declared attackers hold
// exactly one, else toast generically that nothing is legal.

/** A clause that stops a block, captured whole ("protection from black and
 *  from green"), stopping at sentence/HTML boundaries. */
const BLOCK_STOPPER = /\b(protection from[^,.;<]*|menace|can't be blocked[^,.;<]*)/i;

const BLOCK_ASK = /attacker to block/i;

/** Wire the empty-candidates toast. Returns the unsubscribe. */
export function wireNoLegalChoiceDetector(stores: Stores): () => void {
  let lastPromptId: number | undefined = stores.prompt.getState().pending?.promptId;

  return stores.prompt.subscribe(s => {
    const p = s.pending;
    if (p?.promptId === lastPromptId) return;   // scratch churn, not a new ask
    lastPromptId = p?.promptId;
    if (p?.kind !== 'chooseTargets' || p.candidates.length > 0) return;
    const state = stores.game.getState().state;
    const blame = state !== undefined && BLOCK_ASK.test(p.message)
      ? blockCulprit(state) : undefined;
    pushNotice(stores.notices, 'info', blame !== undefined
      ? `Nothing to choose — ${blame}.`
      : `The server offered nothing legal for “${p.message}”.`);
  });
}

/** Name the blocking restriction when exactly one declared attacker carries
 *  one (own text; the granting attachment named when it also carries the
 *  clause — XMage renders granted abilities into the creature's own rules).
 *  More than one story → undefined, same rule as {@link culprit}. */
export function blockCulprit(state: GameState): string | undefined {
  const found: string[] = [];
  const attacking = new Set((state.combat ?? []).flatMap(g => g.attackerIds));
  for (const pl of state.players) {
    const byId = new Map(pl.battlefield.map(perm => [perm.id, perm]));
    for (const perm of pl.battlefield) {
      if (!attacking.has(perm.id)) continue;
      const clause = blockClause(perm.text);
      if (clause === undefined) continue;
      const grantor = (perm.attachments ?? [])
        .map(id => byId.get(id))
        .find(att => att !== undefined && blockClause(att.text) !== undefined);
      found.push(`${perm.name} has ${clause}${grantor !== undefined ? ` (${grantor.name})` : ''}`);
    }
  }
  return found.length === 1 ? found[0] : undefined;
}

function blockClause(text: string[]): string | undefined {
  for (const line of text) {
    const m = BLOCK_STOPPER.exec(line);
    if (m !== null) return m[1]!.trim().toLowerCase();
  }
  return undefined;
}
