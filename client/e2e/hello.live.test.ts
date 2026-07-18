// C0 live check: the real net/connect code path — codec, builders, recorder —
// against a real bridge, through the same URL a dev-mode browser uses (the Vite
// /ws proxy). Node ≥22 ships a browser-style WebSocket, so this exercises the
// production code unmodified; only localStorage is stubbed. The C3 Playwright
// auto-player grows out of this tier (design §13).
//
// Env: NIGHT_WS_URL overrides the target (default: through the Vite dev proxy).

import { beforeEach, expect, it } from 'vitest';
import { Recorder } from '../src/dev/recorder';
import { connect, type ConnectionStatus } from '../src/net/connect';
import type { Welcome } from '../src/protocol/protocol';

const URL_UNDER_TEST = process.env['NIGHT_WS_URL'] ?? 'ws://localhost:5173/ws';

const storage = new Map<string, string>();
beforeEach(() => storage.clear());
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
};

it('completes hello → welcome against the live bridge, dev-strict', async () => {
  const recorder = new Recorder();
  const statuses: ConnectionStatus[] = [];

  const conn = connect({
    url: URL_UNDER_TEST,
    recorder,
    strict: true,
    onStatus: s => statuses.push(s),
  });
  try {
    await expect.poll(() => statuses.at(-1), { timeout: 5000 }).toBe('ready');
  } finally {
    conn.close();
  }

  expect(statuses).toEqual(['connecting', 'helloSent', 'ready']);

  const trace = recorder.entries();
  expect(trace.map(e => [e.dir, (e.msg as { t: string }).t])).toEqual([
    ['out', 'session.hello'],
    ['in', 'session.welcome'],
  ]);

  const hello = trace[0]!.msg as { v: number; token?: string };
  expect(hello.v).toBe(1);
  expect(hello.token).toBeUndefined();          // fresh session — no token yet

  const welcome = trace[1]!.msg as Welcome;
  expect(welcome.resumed).toBe(false);
  expect(welcome.role).toBe('player');
  expect(welcome.token).toBeTruthy();           // bridge-minted (protocol §4)
  expect(storage.get('cn.token')).toBe(welcome.token);   // persisted for later hellos
}, 10000);
