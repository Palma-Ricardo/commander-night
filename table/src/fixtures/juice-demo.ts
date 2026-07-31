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
    // Ana (bottom-right) swings at all three opponents at once, so the reel mans
    // every battle lane: p1 across the vertical seam, p3 across the horizontal
    // seam, p4 at the centre corner (the 45° diagonal). The p3 lane gets a *rank*
    // of four identical goblins, which is the #25 fold — they must arrive as one
    // slot carrying a ×4 tally, not four cards smeared along the seam.
    label: 'attack (all three lanes, one folded rank + danger plates)',
    mutate: s => {
      const gobs = s.players[1]!.battlefield.filter(b => b.name === 'Goblin Token' && !b.tapped).slice(0, 6);
      s.turn.phase = 'COMBAT'; s.turn.step = 'DECLARE_ATTACKERS';
      if (gobs.length < 6) return;
      gobs.forEach(g => { g.tapped = true; });
      s.combat = [
        { attackerIds: [gobs[0]!.id], defenderId: 'p1', blockerIds: [], blocked: false },
        { attackerIds: gobs.slice(1, 5).map(g => g.id), defenderId: 'p3', blockerIds: [], blocked: false },
        { attackerIds: [gobs[5]!.id], defenderId: 'p4', blockerIds: [], blocked: false },
      ];
    },
    events: s => (s.combat ?? []).map(g => ({ k: 'attack', attackerIds: g.attackerIds, defenderId: g.defenderId })),
  },
  {
    label: 'block (stand across the border + nudge back)',
    mutate: s => {
      const c = byName(s, 'p1', 'Sakura-Tribe Elder');
      const g = s.combat?.[0];
      s.turn.step = 'DECLARE_BLOCKERS';
      if (c && g) { g.blockerIds = [c.id]; g.blocked = true; }
    },
    events: s => {
      const c = byName(s, 'p1', 'Sakura-Tribe Elder');
      const g = s.combat?.[0];
      return c && g ? [{ k: 'block', attackerId: g.attackerIds[0]!, blockerIds: [c.id] }] : [];
    },
  },
  {
    // Every lunge kind at once: the blocked pair trade (head-on clash), while the
    // two unblocked goblins punch their defenders' nameplates.
    label: 'combat damage (lunges)',
    mutate: s => {
      s.turn.phase = 'COMBAT'; s.turn.step = 'COMBAT_DAMAGE';
      const c = byName(s, 'p1', 'Sakura-Tribe Elder'); if (c) c.damage = 1;
      const aid = s.combat?.[0]?.attackerIds[0];
      const g = s.players[1]!.battlefield.find(b => b.id === aid); if (g) g.damage = 1;
      s.players[2]!.life = 39;
      s.players[3]!.life = 30;
    },
    events: s => {
      const c = byName(s, 'p1', 'Sakura-Tribe Elder');
      const aid = s.combat?.[0]?.attackerIds[0];
      const ev: GameEvent[] = [
        { k: 'life', playerId: 'p3', from: 40, to: 39 },
        { k: 'damage', targetId: 'p3', amount: 1, combat: true },
        { k: 'life', playerId: 'p4', from: 31, to: 30 },
        { k: 'damage', targetId: 'p4', amount: 1, combat: true },
      ];
      if (c) ev.push({ k: 'damage', targetId: c.id, amount: 1, combat: true });
      if (aid !== undefined) ev.push({ k: 'damage', targetId: aid, amount: 1, combat: true });
      return ev;
    },
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
    label: 'resolve (dust ring + squash)',
    mutate: s => {
      const item = s.stack.find(i => i.id === 'demo-cast');
      if (item?.card) {
        s.stack = s.stack.filter(i => i.id !== 'demo-cast');
        you(s).battlefield.push({ ...item.card, controllerId: 'p1', tapped: false });
      }
    },
    events: s => {
      const p = you(s).battlefield[you(s).battlefield.length - 1];
      return p ? [{ k: 'move', objectId: p.id, from: 'stack', to: 'battlefield', verb: 'resolve' }] : [];
    },
  },
  {
    label: 'destroy (die, then settle)',
    mutate: s => {
      const c = byName(s, 'p1', 'Sakura-Tribe Elder');
      if (c) { you(s).battlefield = you(s).battlefield.filter(b => b.id !== c.id); you(s).graveyard.push(stripPerm(c)); }
    },
    events: s => { const g = you(s).graveyard.find(c => c.name === 'Sakura-Tribe Elder'); return g ? [{ k: 'move', objectId: g.id, from: 'battlefield', to: 'graveyard', verb: 'destroy' }] : []; },
  },
  {
    label: 'sacrifice (implosion)',
    mutate: s => {
      const f = you(s).battlefield.find(b => b.name === 'Forest');
      if (f) { you(s).battlefield = you(s).battlefield.filter(b => b.id !== f.id); you(s).graveyard.push(stripPerm(f)); }
    },
    events: s => {
      const f = you(s).graveyard.find(c => c.name === 'Forest');
      return f ? [{ k: 'move', objectId: f.id, from: 'battlefield', to: 'graveyard', verb: 'sacrifice', cause: { name: 'Dust Bowl' } }] : [];
    },
  },
  {
    label: 'exile (cold rise off-table)',
    mutate: s => {
      const f = you(s).battlefield.find(b => b.name === 'Forest');
      if (f) { you(s).battlefield = you(s).battlefield.filter(b => b.id !== f.id); you(s).exile.push(stripPerm(f)); }
    },
    events: s => {
      const f = you(s).exile.find(c => c.name === 'Forest');
      return f ? [{ k: 'move', objectId: f.id, from: 'battlefield', to: 'exile', verb: 'exile', cause: { name: 'Path to Exile' } }] : [];
    },
  },
  {
    label: 'opponent casts (to be countered)',
    mutate: s => { s.stack.push(spellItem('demo-oppcast', minCard('opp-bolt', 'Lightning Bolt', ['INSTANT']), 'p2')); },
    events: () => [
      { k: 'move', objectId: 'opp-bolt', from: 'hand', to: 'stack', verb: 'cast' },
      { k: 'stackLink', stackId: 'demo-oppcast', objectId: 'opp-bolt' },
    ],
  },
  {
    label: 'countered (shatter)',
    mutate: s => {
      s.stack = s.stack.filter(i => i.id !== 'demo-oppcast');
      s.players[1]!.graveyard.push(minCard('opp-bolt', 'Lightning Bolt', ['INSTANT']));
    },
    events: () => [
      { k: 'move', objectId: 'opp-bolt', from: 'stack', to: 'graveyard', verb: 'counter', cause: { name: 'Counterspell' } },
    ],
  },
  {
    label: 'phase ribbon (combat ends, fighters march home)',
    mutate: s => { s.turn.phase = 'POSTCOMBAT_MAIN'; s.turn.step = 'POST_MAIN'; s.combat = undefined; },
    events: () => [{ k: 'step', phase: 'POSTCOMBAT_MAIN', step: 'POST_MAIN' }],
  },
];

function abilityItem(id: string, sourceId: string, name: string, text: string[]): StackItem {
  return { id, kind: 'ability', controllerId: 'p1', card: minCard(sourceId, name), text };
}
function spellItem(id: string, card: Card, controllerId = 'p1'): StackItem {
  return { id, kind: 'spell', controllerId, card: { ...card }, text: [] };
}
function minCard(id: string, name: string, types: Card['types'] = ['ARTIFACT']): Card {
  return { id, name, set: 'CMR', number: '0', manaValue: 0, types, subtypes: [], supertypes: [], colors: [], text: [] };
}
function stripPerm(p: GameState['players'][number]['battlefield'][number]): Card {
  const { id, name, set, number, manaCost, manaValue, types, subtypes, supertypes, colors, text, power, toughness } = p;
  return { id, name, set, number, manaCost, manaValue, types, subtypes, supertypes, colors, text, power, toughness };
}

/** `?demo=aim`: park a multi-target `chooseTargets` over the demo board so the §7
 *  affordance glow can actually be looked at (Issues.txt #2). It is the one piece
 *  of the table with no other review loop — the screenshot harness settles to a
 *  still frame with no prompt, so every ring change until now was judged from the
 *  code or from a live game. Dev-only, like the reel.
 *
 *  The candidate set is deliberately mixed: a permanent on your own board, a
 *  folded token cell across the table (which is where the "two highlighter
 *  effects" reading came from — every member of a cell rings), one already in the
 *  selection scratch (the `selected` treatment), and a player. */
export function seedAimDemo(stores: Stores): void {
  const s = demoKeyframe.state;
  const mine = s.players[0]!.battlefield.filter(b => !b.types.includes('LAND')).slice(0, 3);
  const theirs = s.players[1]!.battlefield.filter(b => b.token === true).slice(0, 4);
  const candidates = [...mine, ...theirs].map(b => b.id);
  stores.prompt.setState({
    pending: {
      t: 'game.prompt', seq: 90_000, gameId: 'demo', promptId: 90_001,
      message: 'Choose up to four targets (glow review)',
      kind: 'chooseTargets',
      candidates: [...candidates, s.players[2]!.id], min: 0, max: 4, required: false,
    },
    selected: candidates.slice(0, 1),
    inflight: false,
    cantPay: [],
  });
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
