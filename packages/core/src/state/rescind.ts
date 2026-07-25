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
