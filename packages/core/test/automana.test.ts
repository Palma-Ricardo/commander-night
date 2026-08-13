// The auto-mana solver (prompts-on-the-table §6): cost parsing, source
// production reading, the cover planner's two locked preference rules
// (smallest-production-set for colored pips, colorless-first for generic;
// overshoot allowed as tie-break only), pool-spends-first, and the wiring's
// chain discipline — one re-plan after a no-progress click, then stand-down;
// never a Cancel; the toggle re-renders manual immediately.

import { beforeEach, describe, expect, it } from 'vitest';
import { route, type RouteCtx } from '../src/net/route';
import { PendingCommands } from '../src/net/pending';
import { SessionWriter } from '../src/net/session';
import type { Card, GameState, Id, Permanent, Prompt, ServerMsg, StateKeyframe } from '../src/protocol/protocol';
import {
  autoManaAction, hasReservedAbility, parseRemaining, planPayment, sourceProduction,
  wireAutoManaSolver, type PoolColor, type SourceInfo,
} from '../src/state/automana';
import { createStores, type Stores } from '../src/stores';
import { memoryKV } from '../src/stores/storage';

const card = (id: string, name: string, over: Partial<Card> = {}): Card => ({
  id, name, set: 'xln', number: '1', manaValue: 0, types: ['Land'], subtypes: [],
  supertypes: [], colors: [], text: [], ...over,
});

const land = (id: string, name: string, over: Partial<Permanent> = {}): Permanent =>
  ({ ...card(id, name), controllerId: 'me', tapped: false, ...over });

const forest = land('forest', 'Forest', { subtypes: ['Forest'], supertypes: ['Basic'] });
const swamp = land('swamp', 'Swamp', { subtypes: ['Swamp'], supertypes: ['Basic'] });
const plains = land('plains', 'Plains', { subtypes: ['Plains'], supertypes: ['Basic'] });
const tundra = land('tundra', 'Tundra', { subtypes: ['Plains', 'Island'] });
const solRing = land('sol', 'Sol Ring', { types: ['Artifact'], text: ['{T}: Add {C}{C}.'] });
const commandTower = land('tower', 'Command Tower',
  { text: ["{T}: Add one mana of any color in your commander's color identity."] });
const anyColorLand = land('any', 'Unclaimed Territory', { text: ['{T}: Add one mana of any color.'] });

const src = (perm: Permanent, commanderColors: PoolColor[] = []): SourceInfo =>
  ({ id: perm.id, alts: sourceProduction(perm, commanderColors)! });

const noPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

// ── parseRemaining ───────────────────────────────────────────────────────────

describe('parseRemaining', () => {
  it('splits generic and colored pips', () => {
    const pips = parseRemaining('{2}{B}{W}')!;
    expect(pips.generic).toBe(2);
    expect(pips.colored.map(s => [...s])).toEqual([['B'], ['W']]);
  });

  it('hybrid pips accept either half, Phyrexian pips their colored half', () => {
    const pips = parseRemaining('{W/U}{G/P}')!;
    expect([...pips.colored[0]!].sort()).toEqual(['U', 'W']);
    expect([...pips.colored[1]!]).toEqual(['G']);
  });

  it('{C} is a colored-class pip requiring true colorless', () => {
    const pips = parseRemaining('{C}')!;
    expect([...pips.colored[0]!]).toEqual(['C']);
  });

  it('stands down on snow, unannounced X and mono hybrids', () => {
    expect(parseRemaining('{S}')).toBeUndefined();
    expect(parseRemaining('{X}{R}')).toBeUndefined();
    expect(parseRemaining('{2/W}')).toBeUndefined();
  });
});

// ── sourceProduction ─────────────────────────────────────────────────────────

describe('sourceProduction', () => {
  it('reads basic land types from subtypes (duals included)', () => {
    expect(sourceProduction(forest)).toEqual([['G']]);
    expect(sourceProduction(tundra)).toEqual([['W'], ['U']]);
  });

  it('reads plain {T}: Add lines, multi-symbol included', () => {
    expect(sourceProduction(solRing)).toEqual([['C', 'C']]);
    expect(sourceProduction(land('x', 'Azorius Guildgate', { text: ['{T}: Add {W} or {U}.'] })))
      .toEqual([['W'], ['U']]);
  });

  it('any-color wordings: plain is WUBRG, commander identity uses commander colors', () => {
    expect(sourceProduction(anyColorLand)).toEqual([['W'], ['U'], ['B'], ['R'], ['G']]);
    expect(sourceProduction(commandTower, ['W', 'B'])).toEqual([['W'], ['B']]);
    expect(sourceProduction(commandTower, [])).toBeUndefined();   // identity unknown → unreadable
  });

  it('skips conditional and sacrifice-cost lines; nothing readable → undefined', () => {
    expect(sourceProduction(land('n', 'Nykthos-ish', { text: ['{T}: Add {C} for each artifact you control.'] })))
      .toBeUndefined();
    expect(sourceProduction(land('s', 'Sac rock', { text: ['{T}, Sacrifice Sac rock: Add {B}{B}.'] })))
      .toBeUndefined();
  });
});

// ── hasReservedAbility ───────────────────────────────────────────────────────

// The real XMage text for the two cards that motivated this (both animate off a
// cost with no {T}, so the tap they forfeit is the one that would attack).
const ebonyFly = card('fly', 'Ebony Fly', { types: ['Artifact'], text: [
  'Ebony Fly enters tapped.',
  '{T}: Add {C}.',
  '{4}: Roll a d6. Until end of turn, you may have this artifact become an X/X Insect'
    + ' artifact creature with flying, where X is the result.',
  'Whenever Ebony Fly attacks, another target attacking creature gains flying until end of turn.',
] });
const shiftingWoodland = card('wood', 'Shifting Woodland', { text: [
  'This land enters tapped unless you control a Forest.',
  '{T}: Add {G}.',
  'DELIRIUM - {2}{G}{G}: This land becomes a copy of target permanent card in your graveyard'
    + ' until end of turn. Activate only if there are four or more card types among cards in your graveyard.',
] });

describe('hasReservedAbility', () => {
  it('flags a non-mana ability that animates the source into an attacker', () => {
    expect(hasReservedAbility(ebonyFly)).toBe(true);        // {4}: … become an X/X … creature
    expect(hasReservedAbility(shiftingWoodland)).toBe(true); // {2}{G}{G}: … becomes a copy …
  });

  it('flags a non-mana ability whose cost spends the tap', () => {
    const rockHatchery = card('hatch', 'Pentavus-ish', { types: ['Artifact'],
      text: ['{T}: Add {C}.', '{1}, {T}: Put a +1/+1 counter on target creature.'] });
    expect(hasReservedAbility(rockHatchery)).toBe(true);
  });

  it('does not flag plain mana sources', () => {
    expect(hasReservedAbility(forest)).toBe(false);
    expect(hasReservedAbility(solRing)).toBe(false);
    expect(hasReservedAbility(anyColorLand)).toBe(false);
  });

  it('does not flag a second *mana* line (Talisman, filter land)', () => {
    const talisman = card('tal', 'Talisman of Dominance',
      { types: ['Artifact'], text: ['{T}: Add {C}.', '{T}, Pay 1 life: Add {U} or {B}.'] });
    expect(hasReservedAbility(talisman)).toBe(false);
  });

  it('does not flag value a tap cannot foreclose (utility draw, battlefield-dead cycling)', () => {
    const drawRock = card('dr', 'Draw rock', { types: ['Artifact'],
      text: ['{T}: Add {C}.', '{3}: Draw a card.'] });
    expect(hasReservedAbility(drawRock)).toBe(false);   // {3} needs no tap and animates nothing
    const sandbar = land('sb', 'Lonely Sandbar', { subtypes: ['Island'],
      text: ['{T}: Add {U}.', 'Cycling {U} ({U}, Discard this card: Draw a card.)'] });
    expect(hasReservedAbility(sandbar)).toBe(false);     // cycling is dead once on the battlefield
  });
});

// ── planPayment ──────────────────────────────────────────────────────────────

const tapIds = (steps: ReturnType<typeof planPayment>): Id[] =>
  (steps ?? []).filter(s => s.kind === 'tap').map(s => (s as { id: Id }).id);

describe('planPayment', () => {
  it("the doc's example: {2}{B}{W} taps Sol Ring + Swamp + Plains, never the dual", () => {
    const steps = planPayment(parseRemaining('{2}{B}{W}')!, noPool,
      [src(tundra), src(swamp), src(plains), src(solRing)]);
    expect(tapIds(steps).sort()).toEqual(['plains', 'sol', 'swamp']);
  });

  it('colored pips prefer the smallest production set (basics before any-color)', () => {
    const steps = planPayment(parseRemaining('{G}')!, noPool, [src(anyColorLand), src(forest)]);
    expect(tapIds(steps)).toEqual(['forest']);
  });

  it('floating pool spends before any tap, colored match before generic', () => {
    const steps = planPayment(parseRemaining('{1}{B}')!, { ...noPool, B: 1, W: 1 },
      [src(swamp), src(plains)]);
    expect(steps![0]).toEqual({ kind: 'pool', color: 'B' });
    expect(steps![1]).toEqual({ kind: 'pool', color: 'W' });
    expect(tapIds(steps)).toEqual([]);
  });

  it('overshoot is allowed: Sol Ring pays a lone {1}, remainder floats', () => {
    const steps = planPayment(parseRemaining('{1}')!, noPool, [src(solRing)]);
    expect(tapIds(steps)).toEqual(['sol']);
  });

  it('{C} needs true colorless — a Forest cannot cover it', () => {
    expect(planPayment(parseRemaining('{C}')!, noPool, [src(forest)])).toBeUndefined();
    expect(tapIds(planPayment(parseRemaining('{C}')!, noPool, [src(solRing)]))).toEqual(['sol']);
  });

  it('a hybrid pip backtracks off a pool color the other pip needs', () => {
    // pool W must land on {W}; the {W/U} pip taps the tundra
    const steps = planPayment(parseRemaining('{W}{W/U}')!, { ...noPool, W: 1 }, [src(tundra)]);
    expect(steps!.filter(s => s.kind === 'pool')).toEqual([{ kind: 'pool', color: 'W' }]);
    expect(tapIds(steps)).toEqual(['tundra']);
  });

  it('creatures are last-resort sources, below even an any-color land', () => {
    // the RFZB6J incident (2026-07-25): Rishkar grants countered creatures
    // "{T}: Add {G}" — production-set ranking alone tapped the team out of
    // combat every turn. A creature only taps when nothing else covers.
    const dork: SourceInfo = { id: 'dork', alts: [['G']], creature: true };
    const flexible = planPayment(parseRemaining('{G}')!, noPool, [dork, src(anyColorLand)]);
    expect(tapIds(flexible)).toEqual(['any']);
    const forced = planPayment(parseRemaining('{G}{G}')!, noPool, [dork, src(forest)]);
    expect(tapIds(forced).sort()).toEqual(['dork', 'forest']);
  });

  it('uncoverable → undefined', () => {
    expect(planPayment(parseRemaining('{U}{U}')!, noPool, [src(tundra)])).toBeUndefined();
    expect(planPayment(parseRemaining('{4}')!, noPool, [src(forest)])).toBeUndefined();
  });
});

// ── the wired solver ─────────────────────────────────────────────────────────

function gameState(battlefield: Permanent[]): GameState {
  return {
    gameId: 'g1', status: 'active', rollbackTurnsAllowed: false,
    turn: { n: 3, phase: 'PRECOMBAT_MAIN', step: 'PRE_MAIN', activePlayerId: 'me', priorityPlayerId: 'me' },
    players: [
      { id: 'me', name: 'ricardo', human: true, life: 40,
        manaPool: { ...noPool }, librarySize: 90, handSize: 2,
        battlefield, graveyard: [], exile: [], commandZone: [] },
    ],
    stack: [],
    me: { playerId: 'me', hand: [] },
  };
}

const keyframe = (seq: number, battlefield: Permanent[]): StateKeyframe =>
  ({ t: 'game.state', seq, gameId: 'g1', state: gameState(battlefield) });

const ask = (promptId: number, remaining: string, sources: Id[], seq: number): Prompt => ({
  t: 'game.prompt', seq, gameId: 'g1', promptId, kind: 'payMana',
  message: `Pay ${remaining}`, remaining, sources, canCancel: true,
});

let stores: Stores;
let ctx: RouteCtx;
let sent: { kind: 'pool' | 'tap'; promptId: number; what: string }[];

beforeEach(() => {
  const kv = memoryKV();
  stores = createStores(kv);
  ctx = {
    stores,
    pending: new PendingCommands(() => true),
    session: new SessionWriter(stores, kv, () => 0),
    requestResync: () => {},
    rehello: () => {},
    flushParked: () => {},
    devVerify: true,
  };
  sent = [];
  // Mock the two actions the solver may use — there is no Cancel path by
  // construction. clickManaSource mirrors the real action's probe recording so
  // route's cantPay carry-over sees the solver's clicks.
  wireAutoManaSolver(stores, {
    answerPrompt: (promptId, a) => sent.push({ kind: 'pool', promptId, what: a.color }),
    clickManaSource: (promptId, sourceId) => {
      const p = stores.prompt.getState().pending;
      if (p?.kind === 'payMana') {
        stores.prompt.setState({ manaProbe: { sourceId, remaining: p.remaining } });
      }
      sent.push({ kind: 'tap', promptId, what: sourceId });
    },
  });
});

describe('wireAutoManaSolver', () => {
  it('clicks the planned source on a fresh ask and marks the panel as paying', () => {
    route(keyframe(1, [forest, swamp]), ctx);
    route(ask(70, '{G}', ['forest', 'swamp'], 2), ctx);
    expect(sent).toEqual([{ kind: 'tap', promptId: 70, what: 'forest' }]);
    expect(stores.prompt.getState().autoPay).toBe('paying');
  });

  it('spends floating pool before tapping', () => {
    const state = keyframe(1, [forest]);
    state.state.players[0]!.manaPool.G = 1;
    route(state, ctx);
    route(ask(70, '{1}{G}', ['forest'], 2), ctx);
    expect(sent).toEqual([{ kind: 'pool', promptId: 70, what: 'G' }]);
  });

  it('stands down on an unreadable cost without acting', () => {
    route(keyframe(1, [forest]), ctx);
    route(ask(70, '{S}', ['forest'], 2), ctx);
    expect(sent).toEqual([]);
    expect(stores.prompt.getState().autoPay).toBe('stood-down');
  });

  it('stands down when the readable sources cannot cover', () => {
    route(keyframe(1, [forest]), ctx);
    route(ask(70, '{U}', ['forest'], 2), ctx);
    expect(sent).toEqual([]);
    expect(stores.prompt.getState().autoPay).toBe('stood-down');
  });

  it('no-progress: re-plans once around the cantPay source, then stands down', () => {
    const forest2 = land('forest2', 'Forest', { subtypes: ['Forest'], supertypes: ['Basic'] });
    route(keyframe(1, [forest, forest2]), ctx);
    route(ask(70, '{G}', ['forest', 'forest2'], 2), ctx);
    expect(sent).toEqual([{ kind: 'tap', promptId: 70, what: 'forest' }]);

    // re-ask, identical remaining: the probed forest goes cantPay; strike one
    // re-plans onto forest2
    route(ask(71, '{G}', ['forest', 'forest2'], 3), ctx);
    expect(stores.prompt.getState().cantPay).toEqual(['forest']);
    expect(sent[1]).toEqual({ kind: 'tap', promptId: 71, what: 'forest2' });

    // still no progress: strike two stands the solver down for the chain
    route(ask(72, '{G}', ['forest', 'forest2'], 4), ctx);
    expect(sent).toHaveLength(2);
    expect(stores.prompt.getState().autoPay).toBe('stood-down');

    // the stand-down persists across further re-asks of this chain
    route(ask(73, '{G}', ['forest', 'forest2'], 5), ctx);
    expect(sent).toHaveLength(2);
  });

  it('a shrunk remaining is progress: the chain continues clean', () => {
    route(keyframe(1, [forest, swamp]), ctx);
    route(ask(70, '{G}{B}', ['forest', 'swamp'], 2), ctx);
    expect(sent[0]).toEqual({ kind: 'tap', promptId: 70, what: 'forest' });
    route(ask(71, '{B}', ['swamp'], 3), ctx);
    expect(sent[1]).toEqual({ kind: 'tap', promptId: 71, what: 'swamp' });
    expect(stores.prompt.getState().autoPay).toBe('paying');
  });

  it('toggle off: the solver does not act and the ask stays manual', () => {
    stores.game.setState({ autoMana: false });
    route(keyframe(1, [forest]), ctx);
    route(ask(70, '{G}', ['forest'], 2), ctx);
    expect(sent).toEqual([]);
    expect(stores.prompt.getState().autoPay).toBeUndefined();
  });

  it('toggling on mid-ask solves the current ask with a fresh chain', () => {
    stores.game.setState({ autoMana: false });
    route(keyframe(1, [forest]), ctx);
    route(ask(70, '{G}', ['forest'], 2), ctx);
    expect(sent).toEqual([]);
    stores.game.setState({ autoMana: true });
    expect(sent).toEqual([{ kind: 'tap', promptId: 70, what: 'forest' }]);
  });

  it('toggling off mid-payment clears the paying badge immediately', () => {
    route(keyframe(1, [forest]), ctx);
    route(ask(70, '{G}', ['forest'], 2), ctx);
    expect(stores.prompt.getState().autoPay).toBe('paying');
    stores.game.setState({ autoMana: false });
    expect(stores.prompt.getState().autoPay).toBeUndefined();
  });

  it('a non-payMana prompt ends the chain; the next payMana chain starts fresh', () => {
    route(keyframe(1, [forest]), ctx);
    route(ask(70, '{U}', ['forest'], 2), ctx);              // stands down
    expect(stores.prompt.getState().autoPay).toBe('stood-down');
    route({ t: 'game.prompt', seq: 3, gameId: 'g1', promptId: 71, kind: 'priority',
      message: 'Play spells', playable: {}, canPass: true } as Prompt, ctx);
    route(ask(72, '{G}', ['forest'], 4), ctx);              // a new spell, a new chain
    expect(sent).toEqual([{ kind: 'tap', promptId: 72, what: 'forest' }]);
  });
});

describe('wireAutoManaSolver — restricted pool mana (the L3H22Y loop)', () => {
  // Regression for the 2026-08-08 runaway: Troyan's restricted {U} ("spend only
  // to cast spells with mana value 5+ or with {X}") folds into the flat pool
  // count we see (ManaPoolView sums conditional mana in), so it looks spendable
  // but XMage won't apply it — the re-ask returns the same `remaining` with the
  // same floating U. Faithful to the bridge: each accepted click arrives as
  // promptDone(answered) then the re-ask, so `pending` clears for a tick between
  // asks — the very gap that used to reset the no-progress chain and loop.
  const withPoolU1 = (seq: number, battlefield: Permanent[]): StateKeyframe => {
    const k = keyframe(seq, battlefield);
    k.state.players[0]!.manaPool.U = 1;
    return k;
  };
  const reask = (donePromptId: number, next: Prompt, seq: number): void => {
    route({ t: 'game.promptDone', seq, gameId: 'g1', promptId: donePromptId,
      reason: 'answered' } as ServerMsg, ctx);
    route(next, ctx);
  };

  it('retires the restricted pool color and pays by tapping, never looping', () => {
    const reliquary = land('rel', 'Reliquary Tower', { text: ['{T}: Add {C}.'] });
    const island1 = land('isl1', 'Island', { subtypes: ['Island'] });
    const island2 = land('isl2', 'Island', { subtypes: ['Island'] });
    route(withPoolU1(1, [reliquary, island1, island2]), ctx);

    // ask 1: the pool-first plan spends the (restricted) floating U
    route(ask(70, '{2}', ['rel', 'isl1', 'isl2'], 2), ctx);
    expect(sent[0]).toEqual({ kind: 'pool', promptId: 70, what: 'U' });

    // re-ask, same {2} and same floating U: the spend didn't apply → retire U,
    // re-plan onto a real source (colorless-first: the Tower)
    reask(70, ask(71, '{2}', ['rel', 'isl1', 'isl2'], 3), 4);
    expect(sent[1]).toEqual({ kind: 'tap', promptId: 71, what: 'rel' });

    // the tap made progress ({2}→{1}); the chain continues and taps a land
    reask(71, ask(72, '{1}', ['isl1', 'isl2'], 5), 6);
    expect(sent[2]).toEqual({ kind: 'tap', promptId: 72, what: 'isl1' });
    expect(stores.prompt.getState().autoPay).toBe('paying');
  });

  it('stands down when only the restricted pool mana could pay', () => {
    route(withPoolU1(1, []), ctx);
    route(ask(70, '{U}', [], 2), ctx);
    expect(sent[0]).toEqual({ kind: 'pool', promptId: 70, what: 'U' });
    reask(70, ask(71, '{U}', [], 3), 4);              // U retired, nothing else covers {U}
    expect(stores.prompt.getState().autoPay).toBe('stood-down');
    expect(sent).toHaveLength(1);
  });

  it('bounds a true no-progress loop across the answered-done gaps', () => {
    // both the pool spend and the fallback tap fail to apply (remaining never
    // shrinks): two strikes stand it down instead of looping 269 times.
    const island1 = land('isl1', 'Island', { subtypes: ['Island'] });
    route(withPoolU1(1, [island1]), ctx);
    route(ask(70, '{1}', ['isl1'], 2), ctx);
    expect(sent[0]).toEqual({ kind: 'pool', promptId: 70, what: 'U' });   // strike 0
    reask(70, ask(71, '{1}', ['isl1'], 3), 4);
    expect(sent[1]).toEqual({ kind: 'tap', promptId: 71, what: 'isl1' }); // retire U, tap island — strike 1
    reask(71, ask(72, '{1}', ['isl1'], 5), 6);                           // island didn't apply either
    expect(stores.prompt.getState().autoPay).toBe('stood-down');         // strike 2 → stand down
    expect(sent).toHaveLength(2);
  });
});

describe('autoManaAction', () => {
  it('excludes cantPay sources from the plan', () => {
    const state = gameState([forest, anyColorLand]);
    const p = ask(70, '{G}', ['forest', 'any'], 2) as Extract<Prompt, { kind: 'payMana' }>;
    expect(autoManaAction(p, state, [])).toEqual({ act: 'tap', sourceId: 'forest' });
    expect(autoManaAction(p, state, ['forest'])).toEqual({ act: 'tap', sourceId: 'any' });
    expect(autoManaAction(p, state, ['forest', 'any'])).toEqual({ act: 'stand-down' });
  });

  it('deadPool zeroes a floating color so the plan taps instead', () => {
    const state = gameState([forest]);
    state.players[0]!.manaPool.G = 1;
    const p = ask(70, '{G}', ['forest'], 2) as Extract<Prompt, { kind: 'payMana' }>;
    // with the floating G live, the plan spends it; retired, it taps the Forest
    expect(autoManaAction(p, state, [])).toEqual({ act: 'pool', color: 'G' });
    expect(autoManaAction(p, state, [], ['G'])).toEqual({ act: 'tap', sourceId: 'forest' });
    // retired with nothing left to cover the pip → stand down
    expect(autoManaAction(p, gameState([]), [], ['G'])).toEqual({ act: 'stand-down' });
  });

  // Shifting Woodland taps for {G}, but tapping it forfeits the animate that
  // would let it attack — so the solver holds it out of the plan.
  const woodland = land('wood', 'Shifting Woodland', { text: shiftingWoodland.text });

  it('holds out a reserved source, tapping a plain one instead', () => {
    const state = gameState([woodland, forest]);
    const p = ask(70, '{G}', ['wood', 'forest'], 2) as Extract<Prompt, { kind: 'payMana' }>;
    expect(autoManaAction(p, state, [])).toEqual({ act: 'tap', sourceId: 'forest' });
  });

  it('stands down when only a reserved source could pay', () => {
    const state = gameState([woodland]);
    const p = ask(70, '{G}', ['wood'], 2) as Extract<Prompt, { kind: 'payMana' }>;
    expect(autoManaAction(p, state, [])).toEqual({ act: 'stand-down' });
  });
});
