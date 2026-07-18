// C0 shell: connect to the bridge, complete hello → welcome, show the trace.
// The real screen pipeline (home → lobby → game → postGame, design §10) lands
// in C1+; this shell is what the C0 exit criterion demonstrates.

import { useEffect, useState } from 'react';
import { recorder } from '../dev/recorder';
import { connect, type ConnectionStatus } from '../net/connect';
import { DebugPanel } from './DebugPanel';

function bridgeUrl(): string {
  const configured = import.meta.env.VITE_BRIDGE_WS as string | undefined;
  if (configured) return configured;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;   // dev: Vite proxies /ws → 127.0.0.1:8484
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'connecting…',
  helloSent: 'hello sent — waiting for welcome',
  ready: 'ready — session established',
  closed: 'socket closed',
  failed: 'connection failed (is the bridge running on :8484?)',
};

export function App() {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');

  useEffect(() => {
    const conn = connect({
      url: bridgeUrl(),
      recorder,
      strict: import.meta.env.DEV,
      onStatus: setStatus,
    });
    return conn.close;
  }, []);

  return (
    <main className="app">
      <header className="app-header">
        <h1>Commander Night</h1>
        <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>
      </header>
      <DebugPanel recorder={recorder} />
    </main>
  );
}
