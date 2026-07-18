// C0 connection slice: open the socket, complete hello → welcome, trace everything
// through the recorder. The full §5 FSM (backoff, resume, bumped, visibility)
// replaces this in C1 as net/socket.ts + net/session.ts; the hello/welcome and
// token-persistence behavior here carries over unchanged.

import { decode, encode } from '../protocol/codec';
import { defaultContext, hello } from '../protocol/commands';
import type { Recorder } from '../dev/recorder';

export type ConnectionStatus = 'connecting' | 'helloSent' | 'ready' | 'closed' | 'failed';

const TOKEN_KEY = 'cn.token';   // §12: all localStorage keys under `cn.`

export interface C0ConnectionOpts {
  url: string;
  recorder: Recorder;
  strict: boolean;              // dev-strict decode (design §1)
  onStatus(status: ConnectionStatus): void;
}

export function connect(opts: C0ConnectionOpts): { close(): void } {
  const ctx = defaultContext();
  const ws = new WebSocket(opts.url);
  opts.onStatus('connecting');

  ws.onopen = () => {
    const token = localStorage.getItem(TOKEN_KEY) ?? undefined;
    const msg = hello(ctx, token !== undefined ? { token } : {});
    opts.recorder.record('out', msg);
    ws.send(encode(msg));
    opts.onStatus('helloSent');
  };

  ws.onmessage = ev => {
    const r = decode(typeof ev.data === 'string' ? ev.data : '', { strict: opts.strict });
    if (!r.ok) {
      opts.recorder.record('in', { decodeError: r.error, raw: ev.data });
      console.error('[codec]', r.error);
      return;
    }
    if (r.msg === null) {
      opts.recorder.record('in', { ignoredType: r.ignoredType });
      return;
    }
    opts.recorder.record('in', r.msg);
    if (r.msg.t === 'session.welcome') {
      if (r.msg.token !== undefined) localStorage.setItem(TOKEN_KEY, r.msg.token);
      opts.onStatus('ready');
    }
  };

  ws.onerror = () => opts.onStatus('failed');
  ws.onclose = () => opts.onStatus('closed');

  return { close: () => ws.close() };
}
