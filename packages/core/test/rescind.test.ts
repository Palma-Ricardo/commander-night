// §5.6b silent-cast-rescind detection, pinned by the incident that motivated it
// (design doc, tap B2XF4W, 2026-07-25): Entrancing Melody announced at X=5,
// XMage found the only MV-5 creature shrouded by Lightning Greaves and bounced
// the cast with zero feedback. The fixture replays that exact shape through
// route(): cast on the stack → announce ask → stack empty + card back in hand
// → plain priority ⇒ one toast, naming the Greaves. The player's own Cancel
// and a normal resolution must stay silent.

import { beforeEach, describe, expect, it } from 'vitest';
import { PendingCommands } from '../src/net/pending';
import { route, type RouteCtx } from '../src/net/route';
import { SessionWriter } from '../src/net/session';
import type { Card, GameState, Permanent, Prompt, StateKeyframe } from '../src/protocol/protocol';
import { blockCulprit, culprit, wireNoLegalChoiceDetector, wireRescindDetector } from '../src/state/rescind';
import { createStores, type Stores } from '../src/stores';
import { memoryKV } from '../src/stores/storage';

const card = (id: string, name: string, types: string[], text: string[]): Card => ({
  id, name, set: 'xln', number: '55', manaValue: 2, types, subtypes: [], supertypes: [],
  colors: [], text,
});

const perm = (id: string, name: string, types: string[], text: string[], extra: Partial<Permanent> = {}): Permanent =>
  ({ ...card(id, name, types, text), controllerId: 'ai1', tapped: false, ...extra });

const melody = card('melody', 'Entrancing Melody', ['Sorcery'], ['Gain control of target creature with mana value X.']);

const zurgo = perm('zurgo', 'Zurgo Helmsmasher', ['Creature'],
  ['Haste', 'Zurgo Helmsmasher attacks each combat if able.'], { attachments: ['greaves'] });
const greaves = perm('greaves', 'Lightning Greaves', ['Artifact'],
  ['Equipped creature has haste and shroud.', 'Equip {0}'], { attachedTo: 'zurgo' });

function gameState(over: { stack?: GameState['stack']; hand?: Card[]; battlefield?: Permanent[] }): GameState {
  return {
    gameId: 'g1', status: 'active', rollbackTurnsAllowed: false,
    turn: { n: 46, phase: 'PRECOMBAT_MAIN', step: 'PRE_MAIN', activePlayerId: 'me', priorityPlayerId: 'me' },
    players: [
      { id: 'me', name: 'ricardo', human: true, life: 29,
        manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, librarySize: 40, handSize: 3,
        battlefield: [], graveyard: [], exile: [], commandZone: [] },
      { id: 'ai1', name: 'ai_1', human: false, life: 16,
        manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, librarySize: 40, handSize: 5,
        battlefield: over.battlefield ?? [zurgo, greaves], graveyard: [], exile: [], commandZone: [] },
    ],
    stack: over.stack ?? [],
    me: { playerId: 'me', hand: over.hand ?? [] },
  };
}

const keyframe = (seq: number, over: Parameters<typeof gameState>[0]): StateKeyframe =>
  ({ t: 'game.state', seq, gameId: 'g1', state: gameState(over) });

const announce: Prompt = {
  t: 'game.prompt', seq: 11, gameId: 'g1', promptId: 70,
  message: 'Announce the value for {X}', kind: 'chooseAmount', min: 0, max: 1000000,
};
const priority: Prompt = {
  t: 'game.prompt', seq: 21, gameId: 'g1', promptId: 71,
  message: 'Play spells and abilities', kind: 'priority', playable: {}, canPass: true,
};

let stores: Stores;
let ctx: RouteCtx;

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
  wireRescindDetector(stores);
});

const toasts = () => stores.notices.getState().toasts;

/** The cast is on the stack and the announce ask is running. */
function castFlow(): void {
  route(keyframe(10, { stack: [{ id: 'stk1', kind: 'spell', controllerId: 'me', card: melody, text: [] }], hand: [] }), ctx);
  route(announce, ctx);
}

describe('wireRescindDetector', () => {
  it('the B2XF4W Melody shape: rescind toasts and names Lightning Greaves', () => {
    castFlow();
    route(keyframe(20, { stack: [], hand: [melody] }), ctx);   // silently bounced
    route(priority, ctx);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.text).toContain('Entrancing Melody');
    expect(toasts()[0]!.text).toContain('no legal target');
    expect(toasts()[0]!.text).toContain('Zurgo Helmsmasher has shroud from Lightning Greaves');
  });

  it('decided once: the next priority does not re-toast', () => {
    castFlow();
    route(keyframe(20, { stack: [], hand: [melody] }), ctx);
    route(priority, ctx);
    route({ ...priority, promptId: 72, seq: 31 }, ctx);
    expect(toasts()).toHaveLength(1);
  });

  it("the player's own Cancel stays silent", () => {
    castFlow();
    stores.prompt.setState({ lastAnswer: { type: 'cancel' } });
    route(keyframe(20, { stack: [], hand: [melody] }), ctx);
    route(priority, ctx);
    expect(toasts()).toHaveLength(0);
  });

  it('a committed cast (still on the stack at priority) stays silent', () => {
    castFlow();
    route(keyframe(20, { stack: [{ id: 'stk1', kind: 'spell', controllerId: 'me', card: melody, text: [] }], hand: [] }), ctx);
    route(priority, ctx);
    expect(toasts()).toHaveLength(0);
  });

  it('a resolved cast (gone, not in hand) stays silent', () => {
    castFlow();
    route(keyframe(20, { stack: [], hand: [] }), ctx);
    route(priority, ctx);
    expect(toasts()).toHaveLength(0);
  });

  it("an opponent's spell on the stack never arms the watch", () => {
    route(keyframe(10, { stack: [{ id: 'stk2', kind: 'spell', controllerId: 'ai1', card: melody, text: [] }], hand: [melody] }), ctx);
    route(announce, ctx);   // e.g. our ripple-effect amount ask while theirs is on top
    route(keyframe(20, { stack: [], hand: [melody] }), ctx);
    route(priority, ctx);
    expect(toasts()).toHaveLength(0);
  });
});

// §5.6c: the empty ask (live-found in game 4CFQPJ, 2026-07-25) — "Select
// attacker to block" against Tasigur wearing Sword of Feast and Famine arrives
// with ZERO candidates and no personal message; the client tells the story.
describe('wireNoLegalChoiceDetector', () => {
  const tasigur = perm('tasigur', 'Tasigur, the Golden Fang', ['Creature'],
    ['Delve', 'Protection from black and from green'], { attachments: ['sword'] });
  const sword = perm('sword', 'Sword of Feast and Famine', ['Artifact'],
    ['Equipped creature gets +2/+2 and has protection from black and from green.', 'Equip {2}'],
    { attachedTo: 'tasigur' });

  const blockAsk: Prompt = {
    t: 'game.prompt', seq: 11, gameId: 'g1', promptId: 80,
    message: 'Select attacker to block', kind: 'chooseTargets',
    candidates: [], min: 0, max: 1, required: false,
  };

  function withCombat(): GameState {
    const s = gameState({ battlefield: [tasigur, sword] });
    s.combat = [{ attackerIds: ['tasigur'], defenderId: 'me', blockerIds: [], blocked: false }];
    return s;
  }

  beforeEach(() => { wireNoLegalChoiceDetector(stores); });

  it('the 4CFQPJ shape: empty block ask names Tasigur and the Sword', () => {
    route({ t: 'game.state', seq: 10, gameId: 'g1', state: withCombat() }, ctx);
    route(blockAsk, ctx);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.text).toContain('Tasigur, the Golden Fang has protection from black and from green');
    expect(toasts()[0]!.text).toContain('Sword of Feast and Famine');
  });

  it('an empty non-block ask toasts generically, quoting the ask', () => {
    route({ t: 'game.state', seq: 10, gameId: 'g1', state: withCombat() }, ctx);
    route({ ...blockAsk, message: 'Select a nonland card' }, ctx);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.text).toContain('nothing legal');
    expect(toasts()[0]!.text).toContain('Select a nonland card');
  });

  it('candidates present → silent', () => {
    route({ t: 'game.state', seq: 10, gameId: 'g1', state: withCombat() }, ctx);
    route({ ...blockAsk, candidates: ['tasigur'] }, ctx);
    expect(toasts()).toHaveLength(0);
  });

  it('scratch churn on the same promptId does not re-toast', () => {
    route({ t: 'game.state', seq: 10, gameId: 'g1', state: withCombat() }, ctx);
    route(blockAsk, ctx);
    stores.prompt.setState({ inflight: true });
    expect(toasts()).toHaveLength(1);
  });
});

describe('blockCulprit', () => {
  it('two restricted attackers → undefined (no accusation)', () => {
    const a = perm('a1', 'Menace Bear', ['Creature'], ['Menace']);
    const b = perm('b1', 'Pro Bear', ['Creature'], ['Protection from blue']);
    const s = gameState({ battlefield: [a, b] });
    s.combat = [{ attackerIds: ['a1', 'b1'], defenderId: 'me', blockerIds: [], blocked: false }];
    expect(blockCulprit(s)).toBeUndefined();
  });

  it('a non-attacking protected creature tells no story', () => {
    const a = perm('a1', 'Plain Bear', ['Creature'], []);
    const b = perm('b1', 'Pro Bear', ['Creature'], ['Protection from blue']);
    const s = gameState({ battlefield: [a, b] });
    s.combat = [{ attackerIds: ['a1'], defenderId: 'me', blockerIds: [], blocked: false }];
    expect(blockCulprit(s)).toBeUndefined();
  });
});

describe('culprit', () => {
  it('names an attachment-granted keyword', () => {
    expect(culprit(gameState({}))).toBe('Zurgo Helmsmasher has shroud from Lightning Greaves');
  });

  it('names own-text hexproof', () => {
    const slick = perm('c9', 'Slippery Bogle', ['Creature'], ['Hexproof']);
    expect(culprit(gameState({ battlefield: [slick] }))).toBe('Slippery Bogle has hexproof');
  });

  it('two candidate stories → undefined (generic toast beats a wrong accusation)', () => {
    const slick = perm('c9', 'Slippery Bogle', ['Creature'], ['Hexproof']);
    expect(culprit(gameState({ battlefield: [zurgo, greaves, slick] }))).toBeUndefined();
  });

  it('an unequipped board has no story', () => {
    expect(culprit(gameState({ battlefield: [perm('c1', 'Bear', ['Creature'], [])] }))).toBeUndefined();
  });
});
