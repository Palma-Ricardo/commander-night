// Socket FSM tests (design §5): hello construction, backoff ladder with jitter
// pinned, bumped(1008) terminality, fatal stickiness, manual disconnect,
// command correlation + timeout. Fake WebSocket + fake timers — no network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Recorder } from '../src/dev/recorder';
import { createSocketManager, type SocketManager } from '../src/net/socket';
import { createStores, type Stores } from '../src/stores';
import { KEYS, memoryKV, type KV } from '../src/stores/storage';
import { chatSend, defaultContext } from '../src/protocol/commands';
import type { Hello } from '../src/protocol/protocol';

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;   // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWS.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {   // client-initiated close: browser fires onclose(1000-ish)
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' } as CloseEvent);
  }

  // test drivers
  open(): void {
    this.readyState = 1;   // OPEN
    this.onopen?.();
  }

  receive(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

let kv: KV;
let stores: Stores;
let manager: SocketManager;

function makeManager(): SocketManager {
  return createSocketManager({
    stores,
    kv,
    recorder: new Recorder({ now: () => 0 }),
    url: 'ws://test/ws',
    strictDecode: true, devVerify: true,
    wsFactory: url => new FakeWS(url) as unknown as WebSocket,
    jitter: () => 0.5,          // 0.8 + 0.4·0.5 = ×1.0 — delays are exactly the ladder
    now: () => 0,
  });
}

function lastWs(): FakeWS {
  const ws = FakeWS.instances.at(-1);
  if (!ws) throw new Error('no FakeWS created');
  return ws;
}

function helloOf(ws: FakeWS): Hello {
  return JSON.parse(ws.sent[0]!) as Hello;
}

function openAndWelcome(ws: FakeWS, token = 'tok-1'): void {
  ws.open();
  ws.receive({
    t: 'session.welcome', re: helloOf(ws).id, v: 1,
    userId: 'user-1', token, role: 'player', resumed: false,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWS.instances = [];
  kv = memoryKV();
  stores = createStores(kv);
  manager = makeManager();
});

afterEach(() => {
  manager.dispose();
  vi.useRealTimers();
});

describe('hello construction', () => {
  it('sends v1 hello without stateMode (patch mode, the C3 default) and no token on first connect', () => {
    manager.connect();
    expect(stores.connection.getState().status).toBe('connecting');
    lastWs().open();
    const hello = helloOf(lastWs());
    expect(hello.t).toBe('session.hello');
    expect(hello.v).toBe(1);
    expect(hello.stateMode).toBeUndefined();
    expect(hello.token).toBeUndefined();
    expect(stores.connection.getState().status).toBe('helloSent');
  });

  it('sends stateMode keyframes when the debug toggle is on', () => {
    stores.settings.setState({ keyframesMode: true });
    manager.connect();
    lastWs().open();
    expect(helloOf(lastWs()).stateMode).toBe('keyframes');
  });

  it('presents token + resume anchor on reconnect, and resume never rides without a token', () => {
    stores.session.setState({ token: 't-9', resume: { gameId: 'g1', lastSeq: 41 } });
    manager.connect();
    lastWs().open();
    expect(helloOf(lastWs())).toMatchObject({ token: 't-9', resume: { gameId: 'g1', lastSeq: 41 } });

    manager.dispose();
    FakeWS.instances = [];
    stores.session.setState({ token: undefined });
    manager = makeManager();
    manager.connect();
    lastWs().open();
    expect(helloOf(lastWs()).resume).toBeUndefined();
  });

  it('reaches ready on welcome and persists the minted token', () => {
    manager.connect();
    openAndWelcome(lastWs(), 'minted-token');
    expect(stores.connection.getState().status).toBe('ready');
    expect(stores.session.getState()).toMatchObject({ userId: 'user-1', token: 'minted-token' });
    expect(kv.get(KEYS.token)).toBe('minted-token');
  });
});

describe('reconnect ladder', () => {
  it('backs off 1/2/4/8/15/15 s and resets the attempt counter on welcome', () => {
    manager.connect();
    openAndWelcome(lastWs());

    const expected = [1000, 2000, 4000, 8000, 15000, 15000];
    for (const [i, delay] of expected.entries()) {
      lastWs().serverClose(1006);
      expect(stores.connection.getState()).toMatchObject({ status: 'dropped', attempt: i + 1 });
      const before = FakeWS.instances.length;
      vi.advanceTimersByTime(delay - 1);
      expect(FakeWS.instances.length).toBe(before);
      vi.advanceTimersByTime(1);
      expect(FakeWS.instances.length).toBe(before + 1);
      lastWs().open();   // helloSent, but no welcome → next close climbs the ladder
    }

    openAndWelcome(lastWs());
    expect(stores.connection.getState()).toMatchObject({ status: 'ready', attempt: 0 });
    lastWs().serverClose(1006);
    const before = FakeWS.instances.length;
    vi.advanceTimersByTime(1000);   // back to the 1 s rung
    expect(FakeWS.instances.length).toBe(before + 1);
  });

  it('treats close 1008 as bumped and never auto-reconnects', () => {
    manager.connect();
    openAndWelcome(lastWs());
    lastWs().serverClose(1008);
    expect(stores.connection.getState().status).toBe('bumped');
    const count = FakeWS.instances.length;
    vi.advanceTimersByTime(120_000);
    expect(FakeWS.instances.length).toBe(count);
    manager.connect();   // explicit user action reconnects (§10 Use here)
    expect(FakeWS.instances.length).toBe(count + 1);
  });

  it('stays fatal after a fatal error closes the socket', () => {
    manager.connect();
    openAndWelcome(lastWs());
    lastWs().receive({ t: 'error', code: 'UPSTREAM_ERROR', message: 'seat lost', fatal: true });
    expect(stores.connection.getState().status).toBe('fatal');
    lastWs().serverClose(1011);
    expect(stores.connection.getState().status).toBe('fatal');
    const count = FakeWS.instances.length;
    vi.advanceTimersByTime(120_000);
    expect(FakeWS.instances.length).toBe(count);
  });

  it('manual disconnect lands on idle without a reconnect timer', () => {
    manager.connect();
    openAndWelcome(lastWs());
    manager.disconnect();
    expect(stores.connection.getState().status).toBe('idle');
    const count = FakeWS.instances.length;
    vi.advanceTimersByTime(120_000);
    expect(FakeWS.instances.length).toBe(count);
  });
});

describe('resume failure (§5)', () => {
  // The bridge answers hello{token, resume} it can't honor with a non-fatal
  // RESUME_FAILED and waits — the client must drop the anchor and hello again
  // (unknown token *without* resume is a fresh session, protocol §14). The
  // pre-fix bug parked helloSent forever on every dev-restart of the bridge.
  it('clears the anchor, re-helloes on the same socket, and reaches ready', () => {
    stores.session.setState({ token: 't-9', resume: { gameId: 'g1', lastSeq: 41 } });
    kv.set(KEYS.resume, JSON.stringify({ gameId: 'g1', lastSeq: 41 }));
    manager.connect();
    lastWs().open();
    expect(helloOf(lastWs())).toMatchObject({ token: 't-9', resume: { gameId: 'g1', lastSeq: 41 } });

    lastWs().receive({ t: 'error', code: 'RESUME_FAILED', message: 'unknown session token' });
    expect(stores.session.getState().resume).toBeUndefined();
    expect(kv.get(KEYS.resume)).toBeNull();
    const second = JSON.parse(lastWs().sent[1]!) as Hello;
    expect(second.t).toBe('session.hello');
    expect(second.token).toBe('t-9');   // token kept: the bridge treats it as fresh
    expect(second.resume).toBeUndefined();

    lastWs().receive({
      t: 'session.welcome', re: second.id, v: 1,
      userId: 'user-1', token: 'minted-2', role: 'player', resumed: false,
    });
    expect(stores.connection.getState().status).toBe('ready');
    expect(stores.session.getState().token).toBe('minted-2');
  });

  it('does not re-hello when there was no anchor to drop (no loop against a broken bridge)', () => {
    stores.session.setState({ token: 't-9' });
    manager.connect();
    lastWs().open();
    expect(lastWs().sent).toHaveLength(1);

    lastWs().receive({ t: 'error', code: 'RESUME_FAILED', message: 'unknown session token' });
    expect(lastWs().sent).toHaveLength(1);   // parked in helloSent, not looping
    expect(stores.connection.getState().status).toBe('helloSent');
  });
});

describe('command pipeline (§5: retry-once-same-id, park-and-flush)', () => {
  const ctx = defaultContext();

  it('resolves a command with its ack', async () => {
    manager.connect();
    openAndWelcome(lastWs());
    const cmd = chatSend(ctx, { gameId: 'g1', text: 'hi' });
    const reply = manager.send(cmd);
    lastWs().receive({ t: 'ack', re: cmd.id });
    await expect(reply).resolves.toMatchObject({ t: 'ack', re: cmd.id });
  });

  it('retries once with the SAME id after 8 s on an open socket, then resolves on the replayed ack', async () => {
    manager.connect();
    openAndWelcome(lastWs());
    const cmd = chatSend(ctx, { gameId: 'g1', text: 'hi' });
    const reply = manager.send(cmd);
    expect(lastWs().sent).toHaveLength(2);   // hello + cmd

    await vi.advanceTimersByTimeAsync(8000);
    expect(lastWs().sent).toHaveLength(3);
    expect(lastWs().sent[2]).toBe(lastWs().sent[1]);   // byte-identical resend — the idempotency key

    lastWs().receive({ t: 'ack', re: cmd.id });
    await expect(reply).resolves.toMatchObject({ t: 'ack', re: cmd.id });
  });

  it('rejects after the retry also times out (16 s total)', async () => {
    manager.connect();
    openAndWelcome(lastWs());
    const reply = manager.send(chatSend(ctx, { gameId: 'g1', text: 'hi' }));
    const assertion = expect(reply).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(16000);
    await assertion;
  });

  it('parks in-flight and newly-sent commands across a drop and flushes them in order after resume', async () => {
    manager.connect();
    openAndWelcome(lastWs());
    const c1 = chatSend(ctx, { gameId: 'g1', text: 'one' });
    const c2 = chatSend(ctx, { gameId: 'g1', text: 'two' });
    const r1 = manager.send(c1);
    lastWs().serverClose(1006);   // c1 parks — no rejection

    const r2 = manager.send(c2);  // sent while dropped → parked too
    expect(stores.connection.getState().status).toBe('dropped');

    await vi.advanceTimersByTimeAsync(1000);   // reconnect ladder rung 1
    const ws2 = lastWs();
    openAndWelcome(ws2);

    // hello first, then the parked commands in send order, same ids (§14 LRU)
    expect(ws2.sent.map(s => (JSON.parse(s) as { t: string }).t))
      .toEqual(['session.hello', 'chat.send', 'chat.send']);
    expect((JSON.parse(ws2.sent[1]!) as { id: string }).id).toBe(c1.id);
    expect((JSON.parse(ws2.sent[2]!) as { id: string }).id).toBe(c2.id);

    ws2.receive({ t: 'ack', re: c1.id });
    ws2.receive({ t: 'ack', re: c2.id });
    await expect(r1).resolves.toMatchObject({ t: 'ack', re: c1.id });
    await expect(r2).resolves.toMatchObject({ t: 'ack', re: c2.id });
  });

  it('a command whose timeout fires while the socket is down parks instead of rejecting, and flushes on resume', async () => {
    manager.connect();
    openAndWelcome(lastWs());
    const cmd = chatSend(ctx, { gameId: 'g1', text: 'hi' });
    const reply = manager.send(cmd);
    lastWs().serverClose(1006);

    await vi.advanceTimersByTimeAsync(9000);   // past the original arm — parked, silent
    const ws2 = lastWs();
    openAndWelcome(ws2);
    expect((JSON.parse(ws2.sent[1]!) as { id: string }).id).toBe(cmd.id);
    ws2.receive({ t: 'ack', re: cmd.id });
    await expect(reply).resolves.toMatchObject({ t: 'ack', re: cmd.id });
  });

  it('rejects immediately from terminal states (idle), and rejects parked commands on bumped', async () => {
    await expect(manager.send(chatSend(ctx, { gameId: 'g1', text: 'hi' }))).rejects.toThrow('not connected');

    manager.connect();
    openAndWelcome(lastWs());
    const reply = manager.send(chatSend(ctx, { gameId: 'g1', text: 'hi' }));
    const assertion = expect(reply).rejects.toThrow('another tab');
    lastWs().serverClose(1008);   // bumped: no reconnect is coming (§10)
    await assertion;
  });

  it('rejects in-flight commands on manual disconnect', async () => {
    manager.connect();
    openAndWelcome(lastWs());
    const reply = manager.send(chatSend(ctx, { gameId: 'g1', text: 'hi' }));
    const assertion = expect(reply).rejects.toThrow('disconnected');
    manager.disconnect();
    await assertion;
  });
});
