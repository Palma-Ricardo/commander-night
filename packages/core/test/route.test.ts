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
    fileURLToPath(new URL(`../../../docs/protocol/samples/${name}`, import.meta.url)), 'utf8');
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
let flushes: number;
let clock: number;

beforeEach(() => {
  kv = memoryKV();
  stores = createStores(kv);
  resyncs = 0;
  rehellos = 0;
  flushes = 0;
  clock = 0;
  ctx = {
    stores,
    pending: new PendingCommands(() => true),
    session: new SessionWriter(stores, kv, () => clock),
    requestResync: () => resyncs++,
    rehello: () => rehellos++,
    flushParked: () => flushes++,
    devVerify: true,
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

  it('optimistic combat selection survives a same-role re-ask, resets on any other prompt', () => {
    const combat = sample<Prompt>('game.prompt.priority.combat.json');
    if (combat.kind !== 'priority' || combat.combat === undefined) throw new Error('bad sample');
    const attackers = { ...combat, combat: { ...combat.combat, role: 'attackers' as const } };
    const blockers = { ...combat, combat: { ...combat.combat, role: 'blockers' as const } };

    route(attackers, ctx);
    stores.prompt.setState({ combatSelected: ['perm-x'] });   // a toggle-in this seat made

    // the re-fired ask (fresh promptId) is the same declaration episode → carried
    route({ ...attackers, promptId: attackers.promptId + 1, seq: attackers.seq + 1 }, ctx);
    expect(stores.prompt.getState().combatSelected).toEqual(['perm-x']);

    // switching to declare-blockers is a new episode → cleared
    route({ ...blockers, promptId: attackers.promptId + 2, seq: attackers.seq + 2 }, ctx);
    expect(stores.prompt.getState().combatSelected).toEqual([]);

    // and a plain (non-combat) prompt clears it too
    stores.prompt.setState({ combatSelected: ['perm-y'] });
    route({ ...prompt, promptId: prompt.promptId + 9, seq: prompt.seq + 9 }, ctx);
    expect(stores.prompt.getState().combatSelected).toEqual([]);
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

  it('patches apply through route and advance the resume anchor', () => {
    route(keyframe, ctx);
    route({
      t: 'game.patch', seq: keyframe.seq + 1, gameId: 'g1', base: keyframe.seq,
      ops: [{ op: 'replace', path: '/turn/n', value: 4 }],
    }, ctx);
    expect(stores.game.getState().state?.turn.n).toBe(4);
    expect(stores.game.getState().lastAppliedSeq).toBe(keyframe.seq + 1);
    expect(stores.session.getState().resume?.lastSeq).toBe(keyframe.seq + 1);
  });

  it('a base-mismatched patch gates and resyncs exactly once until the keyframe restores live', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    route({ ...keyframe, seq: 12 }, ctx);
    expect(stores.game.getState().syncMode).toBe('live');
    warn.mockRestore();
  });

  it('fatal error parks the connection; PROMPT_STALE stays silent; other unmatched errors toast (§11)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    route({ t: 'error', code: 'PROMPT_STALE', message: 'stale' }, ctx);
    expect(stores.connection.getState().status).toBe('idle');
    expect(stores.notices.getState().toasts).toHaveLength(0);   // §7 silent set

    route({ t: 'error', code: 'BAD_MESSAGE', message: 'too long' }, ctx);
    expect(stores.notices.getState().toasts).toMatchObject([{ kind: 'error', text: 'too long' }]);

    route({ t: 'error', code: 'UPSTREAM_ERROR', message: 'seat lost', fatal: true }, ctx);
    expect(stores.connection.getState()).toMatchObject({ status: 'fatal' });
    warn.mockRestore();
  });

  it('acks settle pending commands', async () => {
    const reply = ctx.pending.send({ t: 'chat.send', id: 'c77', gameId: 'g1', text: 'hi' });
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

  it('game.over records the result and keeps the anchor (resumable through teardown grace, §14)', () => {
    route(keyframe, ctx);
    route({ t: 'game.over', seq: 999, gameId: 'g1', winnerPlayerIds: ['p1'], reason: 'done', finalState: true }, ctx);
    expect(stores.game.getState().over?.reason).toBe('done');
    expect(stores.session.getState().resume).toMatchObject({ gameId: 'g1' });
    expect(JSON.parse(kv.get(KEYS.resume)!)).toMatchObject({ gameId: 'g1' });
  });

  it('lobby.state replaces the snapshot', () => {
    const lobby = sample<ServerMsg & { code: string }>('lobby.state.json');
    route(lobby, ctx);
    expect(stores.lobby.getState().state?.code).toBe(lobby.code);
  });

  describe('seat identity after a recovery join (protocol §5 adopt)', () => {
    const lobbyWith = (seats: { userId: string; name: string }[]) => ({
      t: 'lobby.state' as const, code: 'AB12CD', hostUserId: 'host-1',
      seats: seats.map(s => ({ ...s, ready: false })),
    });

    it('adopts the seat userId matched by display name when our own id is absent', () => {
      // the bridge re-bound "Marta"'s seat to us and never said so
      stores.session.setState({ userId: 'fresh-welcome-id', name: 'Marta' });
      route(lobbyWith([{ userId: 'seat-marta', name: 'Marta' }, { userId: 'seat-ric', name: 'Ricardo' }]), ctx);
      expect(stores.session.getState().userId).toBe('seat-marta');
    });

    it('leaves a seated identity alone (the ordinary join path)', () => {
      stores.session.setState({ userId: 'seat-ric', name: 'Ricardo' });
      route(lobbyWith([{ userId: 'seat-ric', name: 'Ricardo' }]), ctx);
      expect(stores.session.getState().userId).toBe('seat-ric');
    });

    it('does not guess when no seat carries our name', () => {
      stores.session.setState({ userId: 'fresh', name: 'Nobody' });
      route(lobbyWith([{ userId: 'seat-ric', name: 'Ricardo' }]), ctx);
      expect(stores.session.getState().userId).toBe('fresh');
    });
  });

  it('welcome flushes commands parked during the drop (§5)', () => {
    route({ t: 'session.welcome', re: 'c1', v: 1, userId: 'u1', role: 'player', resumed: true }, ctx);
    expect(flushes).toBe(1);
  });

  it("chat from others bumps unreadChat; own echo and backfill duplicates don't (§8)", () => {
    route(keyframe, ctx);   // me.playerId = p1
    const chat = (seq: number, playerId: string) => ({
      t: 'game.log' as const, seq, gameId: 'g1', ts: 0, kind: 'chat' as const, text: 'hi', playerId,
    });
    route(chat(10, 'p2'), ctx);
    route(chat(11, 'p1'), ctx);   // own echo
    route(chat(10, 'p2'), ctx);   // backfill duplicate
    expect(stores.log.getState().unreadChat).toBe(1);
  });

  it('status lines raise the board banner; the next status line replaces it, a keyframe clears it (§11)', () => {
    route(keyframe, ctx);
    const status = (seq: number, text: string) => ({
      t: 'game.log' as const, seq, gameId: 'g1', ts: 0, kind: 'status' as const, text,
    });
    route(status(10, 'reconnecting to the game server…'), ctx);
    expect(stores.game.getState().upstreamNotice).toBe('reconnecting to the game server…');
    route(status(11, 'reconnected'), ctx);
    expect(stores.game.getState().upstreamNotice).toBe('reconnected');
    route({ ...keyframe, seq: 12 }, ctx);
    expect(stores.game.getState().upstreamNotice).toBeUndefined();
  });

  it('RESUME_FAILED with an anchor explains itself with a toast and lands home, not a spinner (§10/§15)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stores.session.setState({ token: 't-1', resume: { gameId: 'g1', lastSeq: 41 } });
    route({ t: 'error', code: 'RESUME_FAILED', message: 'unknown game' }, ctx);
    expect(stores.session.getState().resume).toBeUndefined();
    expect(rehellos).toBe(1);
    expect(stores.notices.getState().toasts).toMatchObject([{ kind: 'info' }]);
    warn.mockRestore();
  });

  it('a keyframe for a different game purges stray log lines from the old game (§10 rematch)', () => {
    route(keyframe, ctx);
    route({ t: 'game.log', seq: 900, gameId: 'g1', ts: 0, kind: 'chat', text: 'Rematch → AB12CD', playerId: 'p2' }, ctx);
    const g2 = JSON.parse(JSON.stringify(keyframe).replace(/"g1"/g, '"g2"')) as StateKeyframe;
    route({ ...g2, seq: 3 }, ctx);
    expect(stores.log.getState().entries).toEqual([]);
    route({ t: 'game.log', seq: 1, gameId: 'g2', ts: 0, kind: 'game', text: 'first' }, ctx);
    expect(stores.log.getState().entries.map(e => e.gameId)).toEqual(['g2']);
  });

  it('teardown-grace chat from a game already left never resurrects the cleared anchor (§10)', () => {
    route(keyframe, ctx);
    stores.game.setState({ state: undefined });                    // rematch reset
    stores.session.setState({ resume: undefined });
    kv.remove(KEYS.resume);
    route({ t: 'game.log', seq: 950, gameId: 'g1', ts: 0, kind: 'chat', text: 'gg', playerId: 'p2' }, ctx);
    expect(stores.session.getState().resume).toBeUndefined();
    expect(kv.get(KEYS.resume)).toBeNull();
  });
});
