// Derived state (design §3/§8): status line, me/opponents split, object lookup
// across zones, commander-damage rows, combat lines, and the prompt-driven
// board affordances (§7: all object affordances derive from the pending
// prompt, never from state). Pure functions — headless-testable, React-free.

import type { Card, GameState, Id, LogEntry, Player, Step } from '../protocol/protocol';
import type { PromptStoreState } from '../stores/prompt';

// ── players ──────────────────────────────────────────────────────────────────

export function me(state: GameState): Player | undefined {
  return state.players.find(p => p.id === state.me.playerId);
}

/** Opponents in seat order starting after me (table feel: play proceeds left). */
export function opponents(state: GameState): Player[] {
  const i = state.players.findIndex(p => p.id === state.me.playerId);
  if (i < 0) return state.players;
  return [...state.players.slice(i + 1), ...state.players.slice(0, i)];
}

export function playerName(state: GameState, id: Id | undefined): string {
  if (id === undefined) return '—';
  return state.players.find(p => p.id === id)?.name ?? objectName(state, id) ?? id;
}

// ── object lookup (stack targets, log refs, commander damage) ────────────────

export function findObject(state: GameState, id: Id): Card | undefined {
  for (const p of state.players) {
    for (const zone of [p.battlefield, p.graveyard, p.exile, p.commandZone] as const) {
      const hit = (zone as readonly Card[]).find(c => c.id === id);
      if (hit) return hit;
    }
    if (p.topCard?.id === id) return p.topCard;   // revealed library top (§6)
  }
  const inHand = state.me.hand.find(c => c.id === id);
  if (inHand) return inHand;
  for (const s of state.stack) {
    if (s.id === id) return s.card;
    if (s.card?.id === id) return s.card;
  }
  for (const w of [...(state.revealed ?? []), ...(state.lookedAt ?? [])]) {
    const hit = w.cards.find(c => c.id === id);
    if (hit) return hit;
  }
  return undefined;
}

export function objectName(state: GameState, id: Id): string | undefined {
  return findObject(state, id)?.name;
}

/** Target display name: player, else object, else a stub. */
export function targetName(state: GameState, id: Id): string {
  const player = state.players.find(p => p.id === id);
  return player?.name ?? objectName(state, id) ?? 'unknown target';
}

// ── status line (§8, derivation prescribed by protocol §2) ───────────────────

const STEP_LABEL: Record<Step, string> = {
  UNTAP: 'Untap', UPKEEP: 'Upkeep', DRAW: 'Draw', PRE_MAIN: 'First main',
  BEGIN_COMBAT: 'Begin combat', DECLARE_ATTACKERS: 'Declare attackers',
  DECLARE_BLOCKERS: 'Declare blockers', FIRST_COMBAT_DAMAGE: 'First-strike damage',
  COMBAT_DAMAGE: 'Combat damage', END_COMBAT: 'End of combat',
  POST_MAIN: 'Second main', END_TURN: 'End step', CLEANUP: 'Cleanup',
};

/** "T4 · Upkeep — waiting for Marta"; a pending prompt's message takes over
 *  while it's ours (every prompt this seat receives is ours). */
export function statusLine(state: GameState, promptMessage?: string): string {
  if (promptMessage !== undefined && promptMessage !== '') return promptMessage;
  // phase/step absent = the pre-game mulligan window (protocol §6)
  if (state.turn.step === undefined) return 'Mulligans';
  const step = STEP_LABEL[state.turn.step];
  const waitingFor = state.turn.priorityPlayerId ?? state.turn.activePlayerId;
  const suffix = waitingFor !== undefined ? ` — waiting for ${playerName(state, waitingFor)}` : '';
  return `T${state.turn.n} · ${step}${suffix}`;
}

/** The step's display label, or the pre-game mulligan window when there is no
 *  step (protocol §6). Drives the top turn ribbon (table client). */
export function stepLabel(step: Step | undefined): string {
  return step === undefined ? 'Mulligans' : STEP_LABEL[step];
}

// ── commander damage (data lives on the victim, §6) ──────────────────────────

export interface CommanderDamageRow { commander: string; amount: number }

/** The commander(s) this state can see for a player, in the two places a
 *  commander is ever visible as one: the command zone, and the battlefield via
 *  the §6 `commander` flag. Neither alone is enough — XMage drops the Commander
 *  command object the moment its card leaves the zone (CardImpl.removeFromZone
 *  case COMMAND), and it only flags permanents — so a commander sitting in a
 *  graveyard is invisible to both, and anything that wants a *stable* identity
 *  line (the table's nameplate, §7.2) still remembers what it has seen. */
export function commanderNames(player: Player): string[] {
  const names = player.commandZone.filter(c => c.kind === 'commander').map(c => c.name);
  for (const p of player.battlefield) {
    if (p.commander === true && !names.includes(p.name)) names.push(p.name);
  }
  return names;
}

export function commanderDamageRows(state: GameState, victim: Player): CommanderDamageRow[] {
  return (victim.commanderDamage ?? [])
    .map(cd => ({
      commander: objectName(state, cd.fromCommanderId) ?? 'unknown commander',
      amount: cd.amount,
    }))
    .sort((a, b) => b.amount - a.amount);
}

// ── combat lines ─────────────────────────────────────────────────────────────

export function combatLines(state: GameState): string[] {
  return (state.combat ?? []).map(g => {
    const attackers = g.attackerIds.map(id => objectName(state, id) ?? 'attacker').join(', ');
    const defender = targetName(state, g.defenderId);
    const blockers = g.blockerIds.map(id => objectName(state, id) ?? 'blocker').join(', ');
    return g.blocked && blockers !== ''
      ? `${attackers} → ${defender} (blocked by ${blockers})`
      : `${attackers} → ${defender}`;
  });
}

// ── prompt-driven affordances (§7) ───────────────────────────────────────────

export interface PlayableAction { kind: 'mana' | 'play' | 'cast' | 'ability'; text: string }

export type Affordance =
  // priority: ≥1 non-mana action — highlighted, click acts
  | { kind: 'action'; actions: PlayableAction[] }
  // priority: mana-only actions — never highlighted; context menu only (§7,
  // the float-mana lesson rendered as UI policy)
  | { kind: 'manaOnly'; actions: PlayableAction[] }
  // chooseTargets candidate
  | { kind: 'target'; selected: boolean }
  // payMana source; cantPay ⇔ a click provably didn't progress payment (§7)
  | { kind: 'source'; cantPay: boolean }
  // combat declaration toggles (priority + combat); role drives the badge
  // (swords for attackers, shield for blockers, §7)
  | { kind: 'combatCandidate'; role: 'attackers' | 'blockers' }
  | { kind: 'combatDeclared'; role: 'attackers' | 'blockers' };

export function affordanceFor(prompt: PromptStoreState, objectId: Id): Affordance | undefined {
  const p = prompt.pending;
  if (p === undefined) return undefined;
  switch (p.kind) {
    case 'priority': {
      if (p.combat !== undefined) {
        // `combatSelected` is this seat's optimistic view (prompt.ts): mid-selection
        // XMage's `declared` is empty, so a just-toggled combatant only reads as
        // declared here. It wins over `candidates` too — a toggled-in id may still
        // be listed as a candidate, and it must show declared so the tap toggles out.
        if (p.combat.declared.includes(objectId) || prompt.combatSelected.includes(objectId)) {
          return { kind: 'combatDeclared', role: p.combat.role };
        }
        if (p.combat.candidates.includes(objectId)) return { kind: 'combatCandidate', role: p.combat.role };
        return undefined;
      }
      const actions = p.playable[objectId];
      if (actions === undefined || actions.length === 0) return undefined;
      const nonMana = actions.filter(a => a.kind !== 'mana');
      return nonMana.length > 0 ? { kind: 'action', actions } : { kind: 'manaOnly', actions };
    }
    case 'chooseTargets':
      return p.candidates.includes(objectId)
        ? { kind: 'target', selected: prompt.selected.includes(objectId) }
        : undefined;
    case 'payMana':
      return p.sources?.includes(objectId) === true
        ? { kind: 'source', cantPay: prompt.cantPay.includes(objectId) }
        : undefined;
    default:
      return undefined;
  }
}

/** §10 rematch convention (zero protocol surface): the host posts
 *  "Rematch → CODE" into the still-open game chat; every client
 *  pattern-matches its own chat rendering. Latest line wins; tolerant of the
 *  arrow surviving XMage's chat round-trip imperfectly. */
export function rematchCode(entries: LogEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind !== 'chat') continue;
    const m = /^Rematch\b\W*([A-Z0-9]{4,12})\s*$/.exec(e.text.trim());
    if (m) return m[1];
  }
  return undefined;
}

/** Zones the board renders as directly clickable objects. Graveyard and exile
 *  are face piles that only render inside a browser modal (§8), and an id can
 *  be absent from the seat's view entirely — targets living there are
 *  unreachable by clicking, so the prompt dock has to offer them itself
 *  (§13's no-dead-end invariant; live-caught 2026-07-19 by "Select a nonland
 *  card from <opponent> graveyard", which rendered zero enabled controls). */
export function isBoardReachable(state: GameState, id: Id): boolean {
  for (const p of state.players) {
    if (p.battlefield.some(c => c.id === id)) return true;
    if (p.commandZone.some(c => c.id === id)) return true;
    // attachments render nested but are themselves entries in `battlefield`
    if (p.topCard?.id === id) return true;   // revealed library top renders on the pile (§6)
  }
  if (state.me.hand.some(c => c.id === id)) return true;
  if (state.stack.some(s => s.id === id || s.card?.id === id)) return true;
  for (const w of [...(state.revealed ?? []), ...(state.lookedAt ?? [])]) {
    if (w.cards.some(c => c.id === id)) return true;
  }
  return false;
}

/** Candidates the board cannot offer, paired with whatever the state knows
 *  about them (undefined → render the id stub; the answer still works). */
export function unreachableCandidates(
  state: GameState, candidates: readonly Id[],
): { id: Id; card: Card | undefined; label: string }[] {
  return candidates
    .filter(id => !isBoardReachable(state, id))
    .map(id => ({ id, card: findObject(state, id), label: targetName(state, id) }));
}
