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
    strictDecode: true,
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
  it('sends v1 hello with stateMode keyframes (C1 default) and no token on first connect', () => {
    manager.connect();
    expect(stores.connection.getState().status).toBe('connecting');
    lastWs().open();
    const hello = helloOf(lastWs());
    expect(hello.t).toBe('session.hello');
    expect(hello.v).toBe(1);
    expect(hello.stateMode).toBe('keyframes');
    expect(hello.token).toBeUndefined();
    expect(stores.connection.getState().status).toBe('helloSent');
  });

  it('omits stateMode when the keyframes toggle is off', () => {
    stores.settings.setState({ keyframesMode: false });
    manager.connect();
    lastWs().open();
    expect(helloOf(lastWs()).stateMode).toBeUndefined();
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

describe('command pipeline', () => {
  const ctx = defaultContext();

  it('resolves a command with its ack', async () => {
    manager.connect();
    openAndWelcome(lastWs());
    const cmd = chatSend(ctx, { gameId: 'g1', text: 'hi' });
    const reply = manager.send(cmd);
    lastWs().receive({ t: 'ack', re: cmd.id });
    await expect(reply).resolves.toMatchObject({ t: 'ack', re: cmd.id });
  });

  it('rejects on the 8 s timeout', async () => {
    manager.connect();
    openAndWelcome(lastWs());
    const reply = manager.send(chatSend(ctx, { gameId: 'g1', text: 'hi' }));
    const assertion = expect(reply).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
  });

  it('rejects immediately when the socket is not open, and fails in-flight commands on drop', async () => {
    await expect(manager.send(chatSend(ctx, { gameId: 'g1', text: 'hi' }))).rejects.toThrow('not connected');

    manager.connect();
    openAndWelcome(lastWs());
    const reply = manager.send(chatSend(ctx, { gameId: 'g1', text: 'hi' }));
    const assertion = expect(reply).rejects.toThrow('socket closed');
    lastWs().serverClose(1006);
    await assertion;
  });
});
