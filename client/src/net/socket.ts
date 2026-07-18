// WS lifecycle FSM (design §5):
//   idle → connecting → helloSent → ready → dropped → (backoff) → connecting …
// Terminal-ish: 'bumped' (WS close 1008 — another tab took the session; reconnect
// only on explicit user action, two tabs auto-bumping each other is a fork bomb)
// and 'fatal' (fatal error, set by route). Backoff 1/2/4/8/15 s capped, ±20 %
// jitter. visibilitychange/online short-circuit the wait: waking from >30 s
// hidden reconnects immediately if closed, else resyncs (the OS may have
// silently killed the socket while the phone was locked).
//
// Factories/clocks are injected for tests; the app's singleton lives in app.ts.

import { decode, encode } from '../protocol/codec';
import { defaultContext, gameResync, hello } from '../protocol/commands';
import type { ClientMsg } from '../protocol/protocol';
import type { Recorder } from '../dev/recorder';
import type { Stores } from '../stores';
import type { KV } from '../stores/storage';
import { PendingCommands, type CommandReply } from './pending';
import { route, type RouteCtx } from './route';
import { SessionWriter } from './session';

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000] as const;
const WAKE_RESYNC_AFTER_MS = 30_000;
export const CLOSE_BUMPED = 1008;   // bridge WsCloseCodes: bumped by a newer connection

export interface SocketManagerOpts {
  stores: Stores;
  kv: KV;
  recorder: Recorder;
  url: string;
  strictDecode: boolean;
  wsFactory?: (url: string) => WebSocket;
  backoffMs?: readonly number[];
  jitter?: () => number;            // [0,1); default Math.random
  now?: () => number;
}

export interface SocketManager {
  /** Open (or explicitly re-open, incl. from bumped/fatal) the connection. */
  connect(): void;
  /** Manual close → idle; no auto-reconnect. */
  disconnect(): void;
  /** Send a command; resolves with its ack/error (rejects on timeout/drop). */
  send(cmd: ClientMsg): Promise<CommandReply>;
  /** Ask for a fresh keyframe for the current game, if any. */
  resyncNow(): void;
  dispose(): void;
}

export function createSocketManager(opts: SocketManagerOpts): SocketManager {
  const { stores, recorder } = opts;
  const backoff = opts.backoffMs ?? BACKOFF_MS;
  const jitter = opts.jitter ?? Math.random;
  const now = opts.now ?? Date.now;
  const wsFactory = opts.wsFactory ?? ((url: string) => new WebSocket(url));
  const ctx = defaultContext();

  const pending = new PendingCommands();
  const sessionWriter = new SessionWriter(stores, opts.kv, now);
  const routeCtx: RouteCtx = {
    stores,
    pending,
    session: sessionWriter,
    requestResync: () => resyncNow(),
    rehello: () => { if (ws?.readyState === WebSocket.OPEN) sendHello(); },
  };

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let manualClose = false;
  let hiddenAt: number | null = null;
  let disposed = false;

  function clearTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function connect(): void {
    if (disposed) return;
    clearTimer();
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    manualClose = false;
    stores.connection.setState({ status: 'connecting' });
    ws = wsFactory(opts.url);
    ws.onopen = onOpen;
    ws.onmessage = onMessage;
    ws.onclose = onClose;
    ws.onerror = () => { /* the close event carries the story */ };
  }

  function sendHello(): void {
    const session = stores.session.getState();
    const keyframes = stores.settings.getState().keyframesMode;
    const msg = hello(ctx, {
      ...(session.token !== undefined ? { token: session.token } : {}),
      // resume without a token is meaningless (§16.6) — anchor rides only with one
      ...(session.token !== undefined && session.resume !== undefined ? { resume: session.resume } : {}),
      ...(keyframes ? { stateMode: 'keyframes' as const } : {}),
    });
    recorder.record('out', msg);
    ws?.send(encode(msg));
    stores.connection.setState({ status: 'helloSent' });
  }

  function onOpen(): void {
    sendHello();
  }

  function onMessage(ev: MessageEvent): void {
    const r = decode(typeof ev.data === 'string' ? ev.data : '', { strict: opts.strictDecode });
    if (!r.ok) {
      recorder.record('in', { decodeError: r.error, raw: ev.data });
      console.error('[codec]', r.error);
      return;
    }
    if (r.msg === null) {
      recorder.record('in', { ignoredType: r.ignoredType });
      return;
    }
    recorder.record('in', r.msg);
    route(r.msg, routeCtx);
  }

  function onClose(ev: CloseEvent): void {
    ws = null;
    pending.rejectAll(`socket closed (${ev.code})`);
    const status = stores.connection.getState().status;

    if (manualClose) {
      manualClose = false;
      stores.connection.setState({ status: 'idle' });
      return;
    }
    if (ev.code === CLOSE_BUMPED) {
      stores.connection.setState({ status: 'bumped', lastError: 'this session was opened in another tab' });
      return;   // no auto-reconnect from bumped (§5/§10)
    }
    if (status === 'fatal') return;   // route() already parked us; stay

    const attempt = stores.connection.getState().attempt + 1;
    stores.connection.setState({
      status: 'dropped',
      attempt,
      lastError: ev.reason || `connection closed (${ev.code})`,
    });
    const base = backoff[Math.min(attempt - 1, backoff.length - 1)]!;
    const delay = Math.round(base * (0.8 + 0.4 * jitter()));
    reconnectTimer = setTimeout(connect, delay);
  }

  function send(cmd: ClientMsg): Promise<CommandReply> {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('not connected'));   // C4 parks & flushes instead
    }
    const reply = pending.track(cmd.id);
    recorder.record('out', cmd);
    ws.send(encode(cmd));
    return reply;
  }

  function resyncNow(): void {
    const gameId = stores.game.getState().state?.gameId ?? stores.session.getState().resume?.gameId;
    if (gameId === undefined) return;
    send(gameResync(ctx, { gameId })).catch(() => { /* resync is best-effort */ });
  }

  function onVisibility(): void {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      hiddenAt = now();
      return;
    }
    const hiddenMs = hiddenAt === null ? 0 : now() - hiddenAt;
    hiddenAt = null;
    if (hiddenMs < WAKE_RESYNC_AFTER_MS) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      const status = stores.connection.getState().status;
      if (status !== 'bumped' && status !== 'fatal' && status !== 'idle') connect();
    } else {
      resyncNow();
    }
  }

  function onOnline(): void {
    if (stores.connection.getState().status === 'dropped') connect();
  }

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  if (typeof window !== 'undefined') window.addEventListener('online', onOnline);

  return {
    connect,
    disconnect(): void {
      clearTimer();
      if (ws) {
        manualClose = true;
        ws.close();
      } else {
        stores.connection.setState({ status: 'idle' });
      }
    },
    send,
    resyncNow,
    dispose(): void {
      disposed = true;
      clearTimer();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
      manualClose = true;
      ws?.close();
      ws = null;
    },
  };
}
