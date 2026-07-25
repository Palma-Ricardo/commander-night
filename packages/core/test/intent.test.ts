// The pending-intent buffer (prompts-on-the-table §4.3): pointTarget answers a
// matching pending chooseTargets directly (single-pick answer / multi toggle),
// buffers otherwise; wireIntentBuffer consumes-or-drops the buffer on the FIRST
// prompt to arrive — a matching single-pick auto-answers, everything else
// (wrong candidate, multi-pick, other kinds) drops it silently. promptDone
// alone never expires it: the follow-up ask lands after the toggle's done.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createActions, type Actions } from '../src/net/actions';
import { PendingCommands, type CommandReply } from '../src/net/pending';
import { route, type RouteCtx } from '../src/net/route';
import { SessionWriter } from '../src/net/session';
import type { SocketManager } from '../src/net/socket';
import { decode } from '../src/protocol/codec';
import type { Answer, ClientMsg, Prompt, ServerMsg, StateKeyframe } from '../src/protocol/protocol';
import { wireIntentBuffer } from '../src/state/intent';
import { createStores, type Stores } from '../src/stores';
import { memoryKV } from '../src/stores/storage';

function sample<T extends ServerMsg>(name: string): T {
  const text = fs.readFileSync(
    fileURLToPath(new URL(`../../../docs/protocol/samples/${name}`, import.meta.url)), 'utf8');
  const r = decode(text, { strict: true });
  if (!r.ok || r.msg === null) throw new Error(`sample ${name} did not decode`);
  return r.msg as T;
}

const keyframe = sample<StateKeyframe>('game.state.json');
const priority = sample<Prompt>('game.prompt.priority.json');
const targetsSample = sample<Prompt>('game.prompt.chooseTargets.json');

function fakeManager() {
  const sent: ClientMsg[] = [];
  const manager: SocketManager = {
    connect() {}, disconnect() {}, resyncNow() {}, dispose() {},
    send(cmd: ClientMsg): Promise<CommandReply> {
      sent.push(cmd);
      return Promise.resolve({ t: 'ack', re: cmd.id } as CommandReply);
    },
  };
  return { manager, sent };
}

let stores: Stores;
let ctx: RouteCtx;
let fake: ReturnType<typeof fakeManager>;
let actions: Actions;
let unwire: () => void;

const followUp = (over: Partial<Extract<Prompt, { kind: 'chooseTargets' }>> = {}): Prompt => ({
  ...targetsSample, kind: 'chooseTargets', promptId: 90, seq: 900,
  candidates: ['pw1', 'playerB'], min: 1, max: 1, required: true,
  message: 'Select defender', ...over,
} as Prompt);

const sentAnswers = (): Answer[] => fake.sent.filter((m): m is Answer => m.t === 'game.answer');

beforeEach(() => {
  const kv = memoryKV();
  stores = createStores(kv);
  fake = fakeManager();
  actions = createActions(stores, fake.manager, kv);
  ctx = {
    stores,
    pending: new PendingCommands(() => true),
    session: new SessionWriter(stores, kv, () => 0),
    requestResync: () => {},
    rehello: () => {},
    flushParked: () => {},
    devVerify: true,
  };
  unwire = wireIntentBuffer(stores.prompt, (pid, a) => void actions.answerPrompt(pid, a));
  route(keyframe, ctx);
});

describe('pointTarget', () => {
  it('matching single-pick pending → answers {object} immediately, no buffer', () => {
    route(followUp(), ctx);
    actions.pointTarget('playerB');
    expect(sentAnswers().at(-1)?.answer).toEqual({ type: 'object', objectId: 'playerB' });
    expect(stores.prompt.getState().intent).toBeUndefined();
  });

  it('matching multi-pick pending → toggles the scratch instead', () => {
    route(followUp({ max: 2 }), ctx);
    actions.pointTarget('pw1');
    expect(stores.prompt.getState().selected).toEqual(['pw1']);
    expect(sentAnswers()).toHaveLength(0);
  });

  it('no matching prompt → buffers the intent', () => {
    route(priority, ctx);
    actions.pointTarget('playerB');
    expect(stores.prompt.getState().intent).toEqual({ targetId: 'playerB' });
    expect(sentAnswers()).toHaveLength(0);
  });
});

describe('wireIntentBuffer', () => {
  it('consumes a matching follow-up: auto-answers and clears', () => {
    route(priority, ctx);
    actions.pointTarget('playerB');
    route(followUp(), ctx);
    const a = sentAnswers().at(-1);
    expect(a?.promptId).toBe(90);
    expect(a?.answer).toEqual({ type: 'object', objectId: 'playerB' });
    expect(stores.prompt.getState().intent).toBeUndefined();
  });

  it('survives promptDone, consumed by the ask that follows', () => {
    route(priority, ctx);
    actions.pointTarget('pw1');
    route({ t: 'game.promptDone', seq: 850, gameId: 'g1', promptId: priority.promptId, reason: 'answered' }, ctx);
    expect(stores.prompt.getState().intent).toEqual({ targetId: 'pw1' });
    route(followUp(), ctx);
    expect(sentAnswers().at(-1)?.answer).toEqual({ type: 'object', objectId: 'pw1' });
  });

  it('drops on the first non-matching prompt — never held across two', () => {
    route(priority, ctx);
    actions.pointTarget('playerB');
    route(followUp({ candidates: ['someone-else'] }), ctx);   // wrong candidates → dropped
    expect(sentAnswers()).toHaveLength(0);
    expect(stores.prompt.getState().intent).toBeUndefined();
    route(followUp({ promptId: 91, seq: 901 }), ctx);         // even a later match stays unanswered
    expect(sentAnswers()).toHaveLength(0);
  });

  it('never auto-answers a multi-pick — dropped instead', () => {
    route(priority, ctx);
    actions.pointTarget('playerB');
    route(followUp({ max: 2 }), ctx);
    expect(sentAnswers()).toHaveLength(0);
    expect(stores.prompt.getState().intent).toBeUndefined();
  });

  it('non-chooseTargets kinds drop the intent too', () => {
    route(priority, ctx);
    actions.pointTarget('playerB');
    route({ ...priority, promptId: 95, seq: 950 }, ctx);
    expect(stores.prompt.getState().intent).toBeUndefined();
    expect(sentAnswers()).toHaveLength(0);
  });

  it('unsubscribe stops consumption', () => {
    unwire();
    route(priority, ctx);
    actions.pointTarget('playerB');
    route(followUp(), ctx);
    expect(sentAnswers()).toHaveLength(0);
    expect(stores.prompt.getState().intent).toEqual({ targetId: 'playerB' });
  });
});
