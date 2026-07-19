// App shell: the screen pipeline (design §1/§10) — home → lobby → game —
// driven entirely by stores, plus the C4 resilience surfaces: the bumped
// takeover screen (§10), the fatal-error modal (§11), and the toast stack
// (§11). Debug panel behind `?debug` or the backtick toggle (design §12).

import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { appActions, appManager, appStores } from '../app';
import type { Notice, SocketStatus } from '../stores';
import { DebugPanel } from './DebugPanel';
import { Game } from './screens/Game';
import { Home } from './screens/Home';
import { Lobby } from './screens/Lobby';

const STATUS_LABEL: Record<SocketStatus, string> = {
  idle: 'disconnected',
  connecting: 'connecting…',
  helloSent: 'hello sent…',
  ready: 'connected',
  dropped: 'reconnecting…',
  bumped: 'opened in another tab',
  fatal: 'connection failed',
};

const TOAST_MS = 5000;

export function App() {
  const conn = useStore(appStores.connection, s => s);
  const inLobby = useStore(appStores.lobby, s => s.state !== undefined);
  const inGame = useStore(appStores.game, s => s.state !== undefined);
  const [showDebug, setShowDebug] = useState(
    () => typeof location !== 'undefined' && location.search.includes('debug'),
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === '`') setShowDebug(d => !d);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // §10: the takeover screen replaces everything — reconnect only on explicit
  // user action (two tabs auto-bumping each other is a fork bomb).
  if (conn.status === 'bumped') {
    return (
      <main className="app">
        <div className="bumped-screen">
          <h1>Session opened in another tab</h1>
          <p>
            This game is now running in a different tab or browser. Only one
            connection can hold the seat at a time.
          </p>
          <button className="use-here" onClick={() => appManager.connect()}>Use here</button>
        </div>
      </main>
    );
  }

  const screen = inGame ? 'game' : inLobby ? 'lobby' : 'home';
  const showReconnect = conn.status === 'fatal' || conn.status === 'idle';

  return (
    <main className={`app${screen === 'game' ? ' app-game' : ''}`}>
      <header className="app-header">
        <h1>Commander Night</h1>
        <span className={`status status-${conn.status}`}>
          {STATUS_LABEL[conn.status]}
          {conn.status === 'dropped' && conn.attempt > 0 ? ` (attempt ${conn.attempt})` : ''}
        </span>
        {showReconnect && (
          <button className="reconnect" onClick={() => appManager.connect()}>Reconnect</button>
        )}
      </header>

      {conn.lastError && conn.status !== 'ready' && (
        <p className="conn-error">{conn.lastError}</p>
      )}

      {screen === 'home' && <Home />}
      {screen === 'lobby' && <Lobby />}
      {screen === 'game' && <Game />}

      {conn.status === 'fatal' && (
        <div className="fatal-overlay">
          <div className="fatal-modal">
            <h2>Connection failed</h2>
            <p>{conn.lastError ?? 'the seat was lost'}</p>
            <button onClick={() => appManager.connect()}>Reconnect</button>
            {inGame && (
              <button onClick={() => appActions.leaveGame()}>Back to home</button>
            )}
          </div>
        </div>
      )}

      <Toaster />
      {showDebug && <DebugPanel />}
    </main>
  );
}

/** §11 toasts: non-fatal unsolicited errors + protocol-layer explanations;
 *  auto-dismiss after 5 s, click to dismiss now. */
function Toaster() {
  const toasts = useStore(appStores.notices, s => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toaster">
      {toasts.map(t => <Toast key={t.id} toast={t} />)}
    </div>
  );
}

function Toast({ toast }: { toast: Notice }) {
  useEffect(() => {
    const timer = setTimeout(() => appActions.dismissNotice(toast.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast.id]);
  return (
    <button className={`toast toast-${toast.kind}`} onClick={() => appActions.dismissNotice(toast.id)}>
      {toast.text}
    </button>
  );
}
