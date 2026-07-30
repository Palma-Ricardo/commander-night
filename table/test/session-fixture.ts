// A synthetic, event-bearing session for the director replay + continuity tests
// (design §12: "recorded sessions re-driven through core + director"). No
// client-format capture with events exists yet — the recorded sessions are
// bridge-side pre-translation GameViews — so this stands in until the table
// client can record its own, exactly as fixtures/keyframe.ts does for T0/T1.
//
// It is a *real* session: full GameStates authored against the wire model (tsc
// checks every field), each carrying the §7.1 events that rode on the transition
// into it, walking one card through every T2 move kind — draw, cast (+stackLink),
// resolve/ETB, dies, exile, bounce — plus a turn-change `step`. Steps are full
// states (not deltas) so they apply as keyframes through @night/core and the
// continuity check can diff consecutive layouts.

import type { Card, GameEvent, GameState, Permanent, Player, StackItem } from '@night/core';
import { mkCard, mkCommander, mkLand, mkPerm } from './helpers';

// Stable object ids the events reference.
export const SPELL = 's-spell';     // cast from hand → stack → battlefield
export const DRAWN = 's-drawn';     // drawn library → hand
export const VICTIM = 's-victim';   // dies battlefield → graveyard
export const GRAVE = 's-grave';     // exiled graveyard → exile
export const BOUNCE = 's-bounce';   // bounced battlefield → hand
export const STK = 'stk-ephemeral'; // the spell's ephemeral stack id (§3)

const spell = mkCard('Elvish Visionary', ['CREATURE'], { id: SPELL, colors: ['G'], power: '1', toughness: '1', manaCost: '{1}{G}', manaValue: 2 });
const drawn = mkCard('Rampant Growth', ['SORCERY'], { id: DRAWN, colors: ['G'], manaCost: '{1}{G}', manaValue: 2 });
const victim = mkCard('Grizzly Bears', ['CREATURE'], { id: VICTIM, colors: ['G'], power: '2', toughness: '2' });
const grave = mkCard('Llanowar Elves', ['CREATURE'], { id: GRAVE, colors: ['G'], power: '1', toughness: '1' });
const bounce = mkCard('Wall of Roots', ['CREATURE'], { id: BOUNCE, colors: ['G'], power: '0', toughness: '5' });

function opponent(id: string, name: string): Player {
  return {
    id, name, human: false, life: 40,
    manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
    librarySize: 70, handSize: 3,
    battlefield: [mkPerm(id, mkLand('Island'))],
    graveyard: [], exile: [], commandZone: [mkCommander(`${name}'s General`)],
  };
}

const me = (): Player => ({
  id: 'p1', name: 'You', human: true, life: 40,
  manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
  librarySize: 60, handSize: 1,
  battlefield: [
    mkPerm('p1', mkLand('Forest')),
    mkPerm('p1', mkLand('Forest')),
    { ...victim, controllerId: 'p1', tapped: false } as Permanent,
    { ...bounce, controllerId: 'p1', tapped: false } as Permanent,
  ],
  graveyard: [grave],
  exile: [],
  commandZone: [mkCommander('Your General')],
});

const INITIAL: GameState = {
  gameId: 'sess', status: 'active', rollbackTurnsAllowed: false,
  turn: { n: 5, phase: 'PRECOMBAT_MAIN', step: 'PRE_MAIN', activePlayerId: 'p1', priorityPlayerId: 'p1' },
  players: [me(), opponent('p2', 'Ana'), opponent('p3', 'Tom'), opponent('p4', 'Marta')],
  stack: [],
  me: { playerId: 'p1', hand: [spell] },
};

export interface SessionStep { label: string; state: GameState; events: GameEvent[] }

const clone = (s: GameState): GameState => structuredClone(s);
const p1 = (s: GameState): Player => s.players.find(p => p.id === 'p1')!;

/** The full session: an initial state (no events → snap) followed by one step
 *  per T2 move kind, each a full state + the events for the transition into it. */
export function demoSession(): { initial: GameState; steps: SessionStep[] } {
  const steps: SessionStep[] = [];
  let s = clone(INITIAL);

  // draw: DRAWN slides library → hand (own draw is visible)
  s = clone(s); p1(s).librarySize -= 1; s.me.hand.push({ ...drawn });
  steps.push({ label: 'draw', state: s, events: [{ k: 'move', objectId: DRAWN, from: 'library', to: 'hand', verb: 'draw' }] });

  // cast: SPELL lifts hand → stack; stackLink binds the ephemeral stack id (§3)
  s = clone(s); s.me.hand = s.me.hand.filter(c => c.id !== SPELL);
  const item: StackItem = { id: STK, kind: 'spell', controllerId: 'p1', card: { ...spell }, text: [] };
  s.stack.push(item);
  steps.push({ label: 'cast', state: s, events: [
    { k: 'move', objectId: SPELL, from: 'hand', to: 'stack', verb: 'cast' },
    { k: 'stackLink', stackId: STK, objectId: SPELL },
  ] });

  // resolve/ETB: stack → battlefield
  s = clone(s); s.stack = s.stack.filter(i => i.id !== STK);
  p1(s).battlefield.push({ ...spell, controllerId: 'p1', tapped: false } as Permanent);
  steps.push({ label: 'resolve', state: s, events: [{ k: 'move', objectId: SPELL, from: 'stack', to: 'battlefield', verb: 'resolve' }] });

  // dies: VICTIM battlefield → graveyard
  s = clone(s); p1(s).battlefield = p1(s).battlefield.filter(p => p.id !== VICTIM);
  p1(s).graveyard.push({ ...victim });
  steps.push({ label: 'dies', state: s, events: [{ k: 'move', objectId: VICTIM, from: 'battlefield', to: 'graveyard', verb: 'destroy', cause: { name: 'Wrath of God' } }] });

  // exile: GRAVE graveyard → exile
  s = clone(s); p1(s).graveyard = p1(s).graveyard.filter(c => c.id !== GRAVE);
  p1(s).exile.push({ ...grave });
  steps.push({ label: 'exile', state: s, events: [{ k: 'move', objectId: GRAVE, from: 'graveyard', to: 'exile', verb: 'exile' }] });

  // bounce: BOUNCE battlefield → hand
  s = clone(s); p1(s).battlefield = p1(s).battlefield.filter(p => p.id !== BOUNCE);
  s.me.hand.push({ ...bounce });
  steps.push({ label: 'bounce', state: s, events: [{ k: 'move', objectId: BOUNCE, from: 'battlefield', to: 'hand', verb: 'bounce' }] });

  // Turn passes to Marta → the camera should follow (§7.3). Marta, not Ana: play
  // moves *backwards* through `players` (see displaySeats), so p4 is who takes the
  // turn after p1 — and is display seat 1, the quadrant to your left.
  s = clone(s); s.turn = { ...s.turn, n: 6, activePlayerId: 'p4', priorityPlayerId: 'p4' };
  steps.push({ label: 'step', state: s, events: [{ k: 'step', phase: 'BEGINNING', step: 'UPKEEP', activePlayerId: 'p4' }] });

  return { initial: clone(INITIAL), steps };
}
