// Routing tests (design §4): each server event mutates exactly its owning store;
// prompt supersede/clear, log ring + dedupe, patch gate, resume-anchor throttle.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decode } from '../src/protocol/codec';
import type { Prompt, ServerMsg, StateKeyframe } from '../src/protocol/protocol';
import { PendingCommands } from '../src/net/pending';
import { route, type RouteCtx } from '../src/net/route';
import { SessionWriter } from '../src/net/session';
import { createStores, type Stores } from '../src/stores';
import { KEYS, memoryKV, type KV } from '../src/stores/storage';

function sample<T extends ServerMsg>(name: string): T {
  const text = fs.readFileSync(
    fileURLToPath(new URL(`../../docs/protocol/samples/${name}`, import.meta.url)), 'utf8');
  const r = decode(text, { strict: true });
  if (!r.ok || r.msg === null) throw new Error(`sample ${name} did not decode`);
  return r.msg as T;
}

const keyframe = sample<StateKeyframe>('game.state.json');
const prompt = sample<Prompt>('game.prompt.priority.json');

let kv: KV;
let stores: Stores;
let ctx: RouteCtx;
let resyncs: number;
let rehellos: number;
let clock: number;

beforeEach(() => {
  kv = memoryKV();
  stores = createStores(kv);
  resyncs = 0;
  rehellos = 0;
  clock = 0;
  ctx = {
    stores,
    pending: new PendingCommands(),
    session: new SessionWriter(stores, kv, () => clock),
    requestResync: () => resyncs++,
    rehello: () => rehellos++,
  };
});

describe('route', () => {
  it('welcome → session identity + connection ready', () => {
    route({ t: 'session.welcome', re: 'c1', v: 1, userId: 'u1', token: 'tk', role: 'player', resumed: false }, ctx);
    expect(stores.connection.getState()).toMatchObject({ status: 'ready', attempt: 0 });
    expect(stores.session.getState()).toMatchObject({ userId: 'u1', token: 'tk' });
    expect(kv.get(KEYS.token)).toBe('tk');
  });

  it('keyframe then prompt (bridge emit order §7): game store and prompt store both land', () => {
    route(keyframe, ctx);
    route(prompt, ctx);
    expect(stores.game.getState().state?.gameId).toBe('g1');
    expect(stores.game.getState().lastAppliedSeq).toBe(keyframe.seq);
    expect(stores.prompt.getState().pending?.promptId).toBe(prompt.promptId);
  });

  it('a mid-game keyframe does NOT clear the pending prompt (§14 resume order)', () => {
    route(prompt, ctx);
    route(keyframe, ctx);
    expect(stores.prompt.getState().pending?.promptId).toBe(prompt.promptId);
  });

  it('a new prompt supersedes; promptDone clears only its own promptId', () => {
    route(prompt, ctx);
    const next = { ...prompt, promptId: prompt.promptId + 1, seq: prompt.seq + 1 };
    route(next, ctx);
    expect(stores.prompt.getState().pending?.promptId).toBe(next.promptId);

    route({ t: 'game.promptDone', seq: 900, gameId: 'g1', promptId: prompt.promptId, reason: 'superseded' }, ctx);
    expect(stores.prompt.getState().pending?.promptId).toBe(next.promptId);   // stale done ignored
    route({ t: 'game.promptDone', seq: 901, gameId: 'g1', promptId: next.promptId, reason: 'answered' }, ctx);
    expect(stores.prompt.getState().pending).toBeUndefined();
  });

  it('log entries dedupe by seq, sort, and ring at 500', () => {
    const entry = (seq: number) => ({
      t: 'game.log' as const, seq, gameId: 'g1', ts: 0, kind: 'game' as const, text: `line ${seq}`,
    });
    route(entry(5), ctx);
    route(entry(3), ctx);
    route(entry(5), ctx);   // backfill duplicate
    expect(stores.log.getState().entries.map(e => e.seq)).toEqual([3, 5]);

    for (let i = 10; i < 520; i++) route(entry(i), ctx);
    const seqs = stores.log.getState().entries.map(e => e.seq);
    expect(seqs.length).toBe(500);
    expect(seqs.at(-1)).toBe(519);
    expect(seqs[0]).toBe(20);   // oldest evicted
  });

  it('patch before C3 gates and resyncs exactly once until the keyframe restores live', () => {
    const patch = {
      t: 'game.patch' as const, seq: 10, gameId: 'g1', base: 9,
      ops: [{ op: 'replace' as const, path: '/turn/n', value: 4 }],
    };
    route(keyframe, ctx);
    route(patch, ctx);
    expect(resyncs).toBe(1);
    expect(stores.game.getState().syncMode).toBe('awaitingKeyframe');
    route({ ...patch, seq: 11, base: 10 }, ctx);
    expect(resyncs).toBe(1);   // gated — no resync storm
    route(keyframe, ctx);
    expect(stores.game.getState().syncMode).toBe('live');
  });

  it('fatal error parks the connection; non-fatal unmatched errors only warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    route({ t: 'error', code: 'PROMPT_STALE', message: 'stale' }, ctx);
    expect(stores.connection.getState().status).toBe('idle');
    expect(warn).toHaveBeenCalled();
    route({ t: 'error', code: 'UPSTREAM_ERROR', message: 'seat lost', fatal: true }, ctx);
    expect(stores.connection.getState()).toMatchObject({ status: 'fatal' });
    warn.mockRestore();
  });

  it('acks settle pending commands', async () => {
    const reply = ctx.pending.track('c77');
    route({ t: 'ack', re: 'c77' }, ctx);
    await expect(reply).resolves.toMatchObject({ t: 'ack', re: 'c77' });
  });

  it('throttles resume-anchor persistence to 1 s but always updates in memory', () => {
    route(keyframe, ctx);
    expect(JSON.parse(kv.get(KEYS.resume)!)).toMatchObject({ lastSeq: keyframe.seq });

    clock = 400;
    route({ ...keyframe, seq: keyframe.seq + 1 }, ctx);
    expect(stores.session.getState().resume?.lastSeq).toBe(keyframe.seq + 1);
    expect(JSON.parse(kv.get(KEYS.resume)!).lastSeq).toBe(keyframe.seq);   // write throttled

    clock = 1500;
    route({ ...keyframe, seq: keyframe.seq + 2 }, ctx);
    expect(JSON.parse(kv.get(KEYS.resume)!).lastSeq).toBe(keyframe.seq + 2);
  });

  it('game.over records the result and clears the resume anchor', () => {
    route(keyframe, ctx);
    route({ t: 'game.over', seq: 999, gameId: 'g1', winnerPlayerIds: ['p1'], reason: 'done', finalState: true }, ctx);
    expect(stores.game.getState().over?.reason).toBe('done');
    expect(stores.session.getState().resume).toBeUndefined();
    expect(kv.get(KEYS.resume)).toBeNull();
  });

  it('lobby.state replaces the snapshot', () => {
    const lobby = sample<ServerMsg & { code: string }>('lobby.state.json');
    route(lobby, ctx);
    expect(stores.lobby.getState().state?.code).toBe(lobby.code);
  });
});
