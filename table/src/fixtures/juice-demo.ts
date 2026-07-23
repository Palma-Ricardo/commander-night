// A scripted juice reel (design §9) for the T4 review loop — dev-only, behind
// `?demo=juice`. It drives the *real* path: each step is a full `game.state`
// keyframe carrying the §7.1 events the bridge would derive, pushed through
// `applyKeyframe` so the game store → TableCanvas → director → scene → Effects
// pipeline animates it exactly as a live game would. It is the only way to see the
// transient juice headlessly (the screenshot harness settles to a still frame),
// and the way Ricardo eyeballs the feel without a bridge running.
//
// The reel accumulates one board across the pass, then re-seeds the base as a
// silent snap and loops, so it plays forever for live review.

import type { Card, GameEvent, GameState, StackItem, StateKeyframe } from '@night/core';
import { applyKeyframe } from '@night/core/state/apply';
import type { Stores } from '@night/core';
import { demoKeyframe } from './keyframe';

interface Beat { label: string; mutate: (s: GameState) => void; events: (s: GameState) => GameEvent[] }

const clone = (s: GameState): GameState => structuredClone(s);
const you = (s: GameState): GameState['players'][number] => s.players[0]!;
const byName = (s: GameState, pid: string, name: string) =>
  s.players.find(p => p.id === pid)!.battlefield.find(b => b.name === name);

// The reel, in play order — each beat lights one row of the §9 catalogue.
const BEATS: Beat[] = [
  {
    label: 'tap (forMana)',
    mutate: s => { const f = you(s).battlefield.find(b => b.name === 'Forest' && !b.tapped); if (f) f.tapped = true; },
    events: s => { const f = you(s).battlefield.find(b => b.name === 'Forest' && b.tapped); return f ? [{ k: 'tap', objectId: f.id, forMana: true }] : []; },
  },
  {
    label: 'counters',
    mutate: s => { const c = byName(s, 'p1', 'Sakura-Tribe Elder'); if (c) c.counters = [{ name: '+1/+1', count: 2 }]; },
    events: s => { const c = byName(s, 'p1', 'Sakura-Tribe Elder'); return c ? [{ k: 'counters', objectId: c.id, name: '+1/+1', from: 0, to: 2 }] : []; },
  },
  {
    label: 'life + vignette',
    mutate: s => { you(s).life = 26; },
    events: () => [{ k: 'life', playerId: 'p1', from: 34, to: 26 }],
  },
  {
    label: 'combat damage',
    mutate: s => {
      s.turn.phase = 'COMBAT'; s.turn.step = 'COMBAT_DAMAGE';
      const c = byName(s, 'p1', 'Sakura-Tribe Elder'); if (c) c.damage = 2;
      you(s).life = 23;
    },
    events: s => {
      const c = byName(s, 'p1', 'Sakura-Tribe Elder');
      const ev: GameEvent[] = [{ k: 'life', playerId: 'p1', from: 26, to: 23 }, { k: 'damage', targetId: 'p1', amount: 3, combat: true }];
      if (c) ev.push({ k: 'damage', targetId: c.id, amount: 2, combat: true });
      return ev;
    },
  },
  {
    label: 'attack',
    mutate: s => {
      const g = s.players[1]!.battlefield.find(b => b.tapped);   // Ana's swung goblin
      s.turn.phase = 'COMBAT'; s.turn.step = 'DECLARE_ATTACKERS';
      if (g) s.combat = [{ attackerIds: [g.id], defenderId: 'p1', blockerIds: [], blocked: false }];
    },
    events: s => { const g = s.players[1]!.battlefield.find(b => b.tapped); return g ? [{ k: 'attack', attackerIds: [g.id], defenderId: 'p1' }] : []; },
  },
  {
    label: 'trigger (ghost)',
    mutate: s => {
      const sol = byName(s, 'p1', 'Sol Ring');
      if (sol) s.stack.push(abilityItem('demo-abil', sol.id, sol.name, ['{T}: Add {C}{C}.']));
    },
    events: s => { const sol = byName(s, 'p1', 'Sol Ring'); return sol ? [{ k: 'stackLink', stackId: 'demo-abil', objectId: sol.id }, { k: 'trigger', sourceId: sol.id, stackId: 'demo-abil' }] : []; },
  },
  {
    label: 'cast (arc + glow)',
    mutate: s => {
      const card = s.me.hand[0];
      if (card) { s.me.hand = s.me.hand.slice(1); s.stack.push(spellItem('demo-cast', card)); }
    },
    events: s => { const card = s.stack.find(i => i.id === 'demo-cast')?.card; return card ? [{ k: 'move', objectId: card.id, from: 'hand', to: 'stack', verb: 'cast' }, { k: 'stackLink', stackId: 'demo-cast', objectId: card.id }] : []; },
  },
  {
    label: 'destroy (die)',
    mutate: s => {
      const c = byName(s, 'p1', 'Sakura-Tribe Elder');
      if (c) { you(s).battlefield = you(s).battlefield.filter(b => b.id !== c.id); you(s).graveyard.push(stripPerm(c)); }
    },
    events: s => { const g = you(s).graveyard.find(c => c.name === 'Sakura-Tribe Elder'); return g ? [{ k: 'move', objectId: g.id, from: 'battlefield', to: 'graveyard', verb: 'destroy' }] : []; },
  },
  {
    label: 'phase ribbon',
    mutate: s => { s.turn.phase = 'POSTCOMBAT_MAIN'; s.turn.step = 'POST_MAIN'; s.combat = undefined; },
    events: () => [{ k: 'step', phase: 'POSTCOMBAT_MAIN', step: 'POST_MAIN' }],
  },
];

function abilityItem(id: string, sourceId: string, name: string, text: string[]): StackItem {
  return { id, kind: 'ability', controllerId: 'p1', card: minCard(sourceId, name), text };
}
function spellItem(id: string, card: Card): StackItem {
  return { id, kind: 'spell', controllerId: 'p1', card: { ...card }, text: [] };
}
function minCard(id: string, name: string): Card {
  return { id, name, set: 'CMR', number: '0', manaValue: 0, types: ['ARTIFACT'], subtypes: [], supertypes: [], colors: [], text: [] };
}
function stripPerm(p: GameState['players'][number]['battlefield'][number]): Card {
  const { id, name, set, number, manaCost, manaValue, types, subtypes, supertypes, colors, text, power, toughness } = p;
  return { id, name, set, number, manaCost, manaValue, types, subtypes, supertypes, colors, text, power, toughness };
}

/** Start the reel. Returns a stop() handle. Dev-only; never called in prod. */
export function runJuiceDemo(stores: Stores, stepMs = 1500): () => void {
  const base = demoKeyframe.state;
  let seq = 10_000;
  let acc = clone(base);
  let i = 0;

  const push = (state: GameState, events: GameEvent[]): void => {
    seq += 1;
    const msg: StateKeyframe = { t: 'game.state', seq, gameId: 'demo', state, ...(events.length ? { events } : {}) };
    applyKeyframe(msg, { stores, requestResync: () => {}, devVerify: false });
  };

  const timer = setInterval(() => {
    if (i >= BEATS.length) {           // pass done → silent re-seed, then loop
      acc = clone(base);
      i = 0;
      push(acc, []);
      return;
    }
    const beat = BEATS[i]!;
    acc = clone(acc);
    beat.mutate(acc);
    push(acc, beat.events(acc));
    i += 1;
  }, stepMs);

  return () => clearInterval(timer);
}
