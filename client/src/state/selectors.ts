// Derived state (design §3/§8): status line, me/opponents split, object lookup
// across zones, commander-damage rows, combat lines, and the prompt-driven
// board affordances (§7: all object affordances derive from the pending
// prompt, never from state). Pure functions — headless-testable, React-free.

import type { Card, GameState, Id, Player, Step } from '../protocol/protocol';
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

// ── commander damage (data lives on the victim, §6) ──────────────────────────

export interface CommanderDamageRow { commander: string; amount: number }

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
        if (p.combat.declared.includes(objectId)) return { kind: 'combatDeclared', role: p.combat.role };
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
