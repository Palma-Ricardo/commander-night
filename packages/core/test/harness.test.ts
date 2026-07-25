// The semantic harness contract (design §12) — `window.__night`, which is what
// the Playwright live tier drives both clients through. Worth unit-covering
// because a bug here fails every live spec in a way that looks like a client bug:
// snapshot/prompt fidelity against the real conformance samples, the click
// dispatch per prompt kind (it must mirror a board click exactly — the classic
// client's interact.ts), and installHarness's core+view assembly.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCoreHarness, installHarness, sceneFromState, type NightScene } from '../src/harness';
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
    fileURLToPath(new URL(`../../../docs/protocol/samples/${name}`, import.meta.url)), 'utf8');
  const r = decode(text, { strict: true });
  if (!r.ok || r.msg === null) throw new Error(`sample ${name} did not decode`);
  return r.msg as T;
}

const keyframe = sample<StateKeyframe>('game.state.json');
const priority = sample<Prompt>('game.prompt.priority.json');
const combat = sample<Prompt>('game.prompt.priority.combat.json');
const payMana = sample<Prompt>('game.prompt.payMana.json');
const targets = sample<Prompt>('game.prompt.chooseTargets.json');

let stores: Stores;
let ctx: RouteCtx;
let sent: ClientMsg[];
let actions: Actions;
let night: ReturnType<typeof createCoreHarness>;

beforeEach(() => {
  const kv = memoryKV();
  stores = createStores(kv);
  sent = [];
  const manager: SocketManager = {
    connect() {}, disconnect() {}, resyncNow() {}, dispose() {},
    send(cmd: ClientMsg): Promise<CommandReply> {
      sent.push(cmd);
      return Promise.resolve({ t: 'ack', re: cmd.id } as CommandReply);
    },
  };
  actions = createActions(stores, manager, kv);
  night = createCoreHarness(stores, actions);
  ctx = {
    stores,
    pending: new PendingCommands(() => true),
    session: new SessionWriter(stores, kv, () => 0),
    requestResync: () => {},
    rehello: () => {},
    flushParked: () => {},
    devVerify: true,
  };
  route(keyframe, ctx);
});

const lastAnswer = (): Answer => {
  const msg = sent.at(-1);
  if (msg?.t !== 'game.answer') throw new Error(`expected game.answer, got ${msg?.t}`);
  return msg;
};

describe('snapshot', () => {
  it('reports the sync health, the seat count and the pending prompt', () => {
    const before = night.snapshot();
    expect(before.gameId).toBe(keyframe.state.gameId);
    expect(before.seats).toBe(keyframe.state.players.length);
    expect(before.over).toBe(false);
    expect(before.syncMode).toBe('live');
    expect(before.promptId).toBeNull();
    expect(before.promptKind).toBeNull();
    // the socket's own state, so a driver can tell a slow game from a lost seat
    expect(before.socket).toBe(stores.connection.getState().status);

    route(priority, ctx);
    const after = night.snapshot();
    expect(after.promptId).toBe(priority.promptId);
    expect(after.promptKind).toBe('priority');
    expect(after.turn).toBe(keyframe.state.turn.n);
  });

  it('surfaces payRemaining and combatRole — the two progress signals the driver needs', () => {
    route(payMana, ctx);
    expect(night.snapshot().payRemaining)
      .toBe((payMana as Extract<Prompt, { kind: 'payMana' }>).remaining);
    expect(night.snapshot().combatRole).toBeNull();

    route({ ...combat, seq: combat.seq + 10 }, ctx);
    expect(night.snapshot().combatRole)
      .toBe((combat as Extract<Prompt, { kind: 'priority' }>).combat?.role);
    expect(night.snapshot().payRemaining).toBeNull();
  });
});

describe('prompt', () => {
  it('is null with nothing pending', () => {
    expect(night.prompt()).toBeNull();
  });

  it('hands back the wire prompt, the selection scratch and my mana pool', () => {
    route(targets, ctx);
    const view = night.prompt()!;
    expect(view.pending).toEqual(targets);
    expect(view.selected).toEqual([]);
    expect(view.cantPay).toEqual([]);
    // whatever the keyframe's own seat holds — the payMana path spends this first
    const mine = keyframe.state.players.find(p => p.id === keyframe.state.me.playerId)!;
    expect(view.pool).toEqual(mine.manaPool);
  });

  it('tracks accumulated targets', () => {
    const p = targets as Extract<Prompt, { kind: 'chooseTargets' }>;
    route(targets, ctx);
    actions.toggleTarget(targets.promptId, p.candidates[0]!);
    expect(night.prompt()!.selected).toEqual([p.candidates[0]]);
  });
});

describe('click dispatch', () => {
  it('priority: acts on the object (§7 — the server disambiguates several actions)', () => {
    route(priority, ctx);
    night.click('card-9');
    expect(lastAnswer().answer).toEqual({ type: 'object', objectId: 'card-9' });
  });

  it('chooseTargets: a single-target pick answers in one click, like a board click', () => {
    const p = targets as Extract<Prompt, { kind: 'chooseTargets' }>;
    route({ ...targets, max: 1 } as Prompt, ctx);
    night.click(p.candidates[0]!);
    expect(lastAnswer().answer).toEqual({ type: 'object', objectId: p.candidates[0] });
  });

  it('chooseTargets: a multi-target pick accumulates scratch and sends nothing yet', () => {
    const p = targets as Extract<Prompt, { kind: 'chooseTargets' }>;
    route({ ...targets, min: 1, max: 2 } as Prompt, ctx);
    night.click(p.candidates[0]!);
    expect(sent).toHaveLength(0);
    expect(night.prompt()!.selected).toEqual([p.candidates[0]]);
    night.answer({ type: 'objects', objectIds: [p.candidates[0]!] });
    expect(lastAnswer().answer).toEqual({ type: 'objects', objectIds: [p.candidates[0]] });
  });

  it('payMana: a source click goes through the mana-source path', () => {
    const p = payMana as Extract<Prompt, { kind: 'payMana' }>;
    route(payMana, ctx);
    night.click(p.sources![0]!);
    expect(lastAnswer()).toMatchObject({
      promptId: payMana.promptId, answer: { type: 'object', objectId: p.sources![0] },
    });
  });

  it('pass declines the pending prompt', () => {
    route(priority, ctx);
    night.pass();
    expect(lastAnswer().answer).toEqual({ type: 'confirm', value: false });
  });

  it('every action is a no-op with nothing pending', () => {
    night.click('card-9');
    night.pass();
    night.answer({ type: 'cancel' });
    expect(sent).toHaveLength(0);
  });

  it('an explicit promptId drops an answer the supersede already invalidated', () => {
    // what the dock gets for free by capturing the id it rendered with: a caller
    // that decided its answer for prompt N must not have it land on N+1
    route(priority, ctx);
    const stale = priority.promptId;
    route({ ...priority, promptId: stale + 1, seq: priority.seq + 2 }, ctx);
    night.answer({ type: 'confirm', value: false }, stale);
    night.pass(stale);
    night.click('card-9', stale);
    expect(sent).toHaveLength(0);
    // ...while the pending id goes through
    night.pass(stale + 1);
    expect(lastAnswer()).toMatchObject({ promptId: stale + 1 });
  });
});

describe('installHarness', () => {
  it('assembles the core half with the client-supplied view half', () => {
    const scene: NightScene = { actors: [], animating: true };
    const win = {} as Window;
    installHarness(win, night, { scene: () => scene, highlights: () => ['card-9'] });
    expect(win.__night!.snapshot().gameId).toBe(keyframe.state.gameId);
    expect(win.__night!.scene()).toBe(scene);
    expect(win.__night!.highlights()).toEqual(['card-9']);
  });

  it('the state-derived scene covers every zone the trimmed state names', () => {
    const s = sceneFromState(stores.game.getState().state);
    expect(s.actors.length).toBeGreaterThan(0);
    expect(s.animating).toBe(false);
    for (const a of s.actors) expect(a.zone).toBeTruthy();
  });
});
