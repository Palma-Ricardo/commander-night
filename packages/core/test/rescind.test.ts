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
import { culprit, wireRescindDetector } from '../src/state/rescind';
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
