// Prompt answering (design §7/§13): promptId capture + stale-click drop,
// inflight lifecycle (set on submit, cleared by promptDone/supersede, restored
// on INVALID_ANSWER), PROMPT_STALE swallowed, target scratch toggling with max
// cap, and the payMana no-progress → cant-pay detection.

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
import { createStores, type Stores } from '../src/stores';
import { memoryKV } from '../src/stores/storage';

function sample<T extends ServerMsg>(name: string): T {
  const text = fs.readFileSync(
    fileURLToPath(new URL(`../../docs/protocol/samples/${name}`, import.meta.url)), 'utf8');
  const r = decode(text, { strict: true });
  if (!r.ok || r.msg === null) throw new Error(`sample ${name} did not decode`);
  return r.msg as T;
}

const keyframe = sample<StateKeyframe>('game.state.json');
const priority = sample<Prompt>('game.prompt.priority.json');
const payMana = sample<Prompt>('game.prompt.payMana.json');
const targets = sample<Prompt>('game.prompt.chooseTargets.json');

/** Fake manager: records sends, replies from a scriptable queue (default ack). */
function fakeManager() {
  const sent: ClientMsg[] = [];
  const replies: ((cmd: ClientMsg) => CommandReply)[] = [];
  const manager: SocketManager = {
    connect() {}, disconnect() {}, resyncNow() {}, dispose() {},
    send(cmd: ClientMsg): Promise<CommandReply> {
      sent.push(cmd);
      const next = replies.shift() ?? ((c: ClientMsg) => ({ t: 'ack', re: c.id }) as CommandReply);
      return Promise.resolve(next(cmd));
    },
  };
  return { manager, sent, replies };
}

let stores: Stores;
let ctx: RouteCtx;
let fake: ReturnType<typeof fakeManager>;
let actions: Actions;

beforeEach(() => {
  const kv = memoryKV();
  stores = createStores(kv);
  fake = fakeManager();
  actions = createActions(stores, fake.manager, kv);
  ctx = {
    stores,
    pending: new PendingCommands(),
    session: new SessionWriter(stores, kv, () => 0),
    requestResync: () => {},
    rehello: () => {},
    devVerify: true,
  };
  route(keyframe, ctx);
});

const lastAnswer = (): Answer => {
  const msg = fake.sent.at(-1);
  if (msg?.t !== 'game.answer') throw new Error(`expected game.answer, got ${msg?.t}`);
  return msg;
};

describe('answerPrompt', () => {
  it('sends the rendered promptId and sets inflight (kept after ack, §7)', async () => {
    route(priority, ctx);
    const p = actions.answerPrompt(priority.promptId, { type: 'confirm', value: false });
    expect(stores.prompt.getState().inflight).toBe(true);
    await p;
    expect(lastAnswer()).toMatchObject({
      gameId: 'g1', promptId: priority.promptId, answer: { type: 'confirm', value: false },
    });
    expect(stores.prompt.getState().inflight).toBe(true);   // until promptDone/supersede
  });

  it('drops a click whose rendered promptId is no longer pending', async () => {
    route(priority, ctx);
    route({ ...priority, promptId: priority.promptId + 1, seq: priority.seq + 2 }, ctx);
    await actions.answerPrompt(priority.promptId, { type: 'confirm', value: false });
    expect(fake.sent).toHaveLength(0);
  });

  it('drops a second answer while one is inflight', async () => {
    route(priority, ctx);
    const first = actions.answerPrompt(priority.promptId, { type: 'confirm', value: false });
    await actions.answerPrompt(priority.promptId, { type: 'confirm', value: false });
    await first;
    expect(fake.sent).toHaveLength(1);
  });

  it('object answers record actedOn for the spinner badge', () => {
    route(priority, ctx);
    void actions.answerPrompt(priority.promptId, { type: 'object', objectId: 'card-9' });
    expect(stores.prompt.getState().actedOn).toBe('card-9');
  });

  it('INVALID_ANSWER leaves the prompt pending and re-enables the dock', async () => {
    route(priority, ctx);
    fake.replies.push(cmd => ({ t: 'error', re: cmd.id, code: 'INVALID_ANSWER', message: 'nope' }));
    await actions.answerPrompt(priority.promptId, { type: 'confirm', value: false });
    expect(stores.prompt.getState().pending?.promptId).toBe(priority.promptId);
    expect(stores.prompt.getState().inflight).toBe(false);
  });

  it('PROMPT_STALE is swallowed and never touches the superseding prompt', async () => {
    route(priority, ctx);
    fake.replies.push(cmd => {
      // the superseding prompt arrives before the stale error (bridge emit order)
      route({ ...priority, promptId: priority.promptId + 1, seq: priority.seq + 2 }, ctx);
      void actions.answerPrompt(priority.promptId + 1, { type: 'confirm', value: false });
      return { t: 'error', re: cmd.id, code: 'PROMPT_STALE', message: 'stale' };
    });
    await actions.answerPrompt(priority.promptId, { type: 'confirm', value: false });
    // the new prompt's own inflight answer is unaffected by the stale reply
    expect(stores.prompt.getState().pending?.promptId).toBe(priority.promptId + 1);
    expect(stores.prompt.getState().inflight).toBe(true);
  });

  it('promptDone clears pending + scratch; supersede resets inflight', async () => {
    route(priority, ctx);
    void actions.answerPrompt(priority.promptId, { type: 'confirm', value: false });
    route({ t: 'game.promptDone', seq: 900, gameId: 'g1', promptId: priority.promptId, reason: 'answered' }, ctx);
    const s = stores.prompt.getState();
    expect(s.pending).toBeUndefined();
    expect(s.inflight).toBe(false);

    route(priority, ctx);
    void actions.answerPrompt(priority.promptId, { type: 'confirm', value: false });
    expect(stores.prompt.getState().inflight).toBe(true);
    route({ ...priority, promptId: priority.promptId + 1, seq: priority.seq + 2 }, ctx);
    expect(stores.prompt.getState().inflight).toBe(false);
  });
});

describe('toggleTarget', () => {
  it('accumulates up to max, toggles off, ignores non-candidates', () => {
    route(targets, ctx);   // candidates aaa-1/bbb-2, min 1, max 2
    const pid = targets.promptId;
    actions.toggleTarget(pid, 'aaa-1');
    actions.toggleTarget(pid, 'zzz');
    expect(stores.prompt.getState().selected).toEqual(['aaa-1']);
    actions.toggleTarget(pid, 'bbb-2');
    expect(stores.prompt.getState().selected).toEqual(['aaa-1', 'bbb-2']);
    actions.toggleTarget(pid, 'aaa-1');
    expect(stores.prompt.getState().selected).toEqual(['bbb-2']);
  });

  it('caps at max', () => {
    route({ ...targets, max: 1, seq: targets.seq + 1 } as Prompt, ctx);
    actions.toggleTarget(targets.promptId, 'aaa-1');
    actions.toggleTarget(targets.promptId, 'bbb-2');
    expect(stores.prompt.getState().selected).toEqual(['aaa-1']);
  });

  it('ignores a stale promptId', () => {
    route(targets, ctx);
    actions.toggleTarget(targets.promptId + 5, 'aaa-1');
    expect(stores.prompt.getState().selected).toEqual([]);
  });
});

describe('payMana no-progress detection (§7)', () => {
  it('an identical re-ask after a source click marks the source cant-pay', async () => {
    route(payMana, ctx);   // remaining {1}{U}, sources land-1/land-2
    await actions.clickManaSource(payMana.promptId, 'land-1');
    expect(lastAnswer().answer).toEqual({ type: 'object', objectId: 'land-1' });

    // re-ask, identical remaining → land-1 provably can't pay
    route({ ...payMana, promptId: payMana.promptId + 1, seq: payMana.seq + 2 }, ctx);
    expect(stores.prompt.getState().cantPay).toEqual(['land-1']);

    // clicking the other source and getting a SHRUNK re-ask clears the set
    await actions.clickManaSource(payMana.promptId + 1, 'land-2');
    route({ ...payMana, promptId: payMana.promptId + 2, seq: payMana.seq + 4, remaining: '{U}' } as Prompt, ctx);
    expect(stores.prompt.getState().cantPay).toEqual([]);
  });

  it('a non-payMana follow-up resets the probe entirely', async () => {
    route(payMana, ctx);
    await actions.clickManaSource(payMana.promptId, 'land-1');
    route(priority, ctx);
    expect(stores.prompt.getState().cantPay).toEqual([]);
    expect(stores.prompt.getState().manaProbe).toBeUndefined();
  });
});
