// C0/C1 live check: the real client stack (stores + socket FSM + codec +
// recorder) against a real bridge, through the same URL a dev-mode browser uses
// (the Vite /ws proxy). Node ≥22 ships a browser-style WebSocket, so this runs
// the production code unmodified.
//
// Env: NIGHT_WS_URL overrides the target (default: through the Vite dev proxy).

import { expect, it } from 'vitest';
import { Recorder } from '../src/dev/recorder';
import { createSocketManager } from '../src/net/socket';
import { createStores } from '../src/stores';
import { KEYS, memoryKV } from '../src/stores/storage';
import type { Welcome } from '../src/protocol/protocol';

const URL_UNDER_TEST = process.env['NIGHT_WS_URL'] ?? 'ws://localhost:5173/ws';

it('completes hello → welcome against the live bridge, dev-strict', async () => {
  const kv = memoryKV();
  const stores = createStores(kv);
  const recorder = new Recorder();
  const manager = createSocketManager({
    stores, kv, recorder, url: URL_UNDER_TEST, strictDecode: true, devVerify: true,
  });

  try {
    manager.connect();
    await expect.poll(() => stores.connection.getState().status, { timeout: 5000 }).toBe('ready');
  } finally {
    manager.dispose();
  }

  const trace = recorder.entries();
  expect(trace.map(e => [e.dir, (e.msg as { t: string }).t])).toEqual([
    ['out', 'session.hello'],
    ['in', 'session.welcome'],
  ]);

  const hello = trace[0]!.msg as { v: number; token?: string; stateMode?: string };
  expect(hello.v).toBe(1);
  expect(hello.token).toBeUndefined();            // fresh session — no token yet
  expect(hello.stateMode).toBe('keyframes');      // C1 default (§6)

  const welcome = trace[1]!.msg as Welcome;
  expect(welcome.resumed).toBe(false);
  expect(welcome.role).toBe('player');
  expect(welcome.token).toBeTruthy();             // bridge-minted (protocol §4)
  expect(kv.get(KEYS.token)).toBe(welcome.token!);   // persisted for later hellos
}, 10000);
