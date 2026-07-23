// The table client shell (design §11 chrome/). One Pixi canvas fills the viewport
// as the backdrop; the React screen pipeline — home → lobby → game — floats over
// it, driven entirely by stores, plus the C4/§11 resilience surfaces (bumped
// takeover, fatal modal, toast stack). Home and lobby are opaque panels over the
// felt; the game is a transparent overlay (GameOverlay) so the live table shows
// through. Ported in shape from client/src/ui/App.tsx, minus the DOM board.

import { useEffect } from 'react';
import { useStore } from 'zustand';
import { appActions, appManager, appStores } from '../app';
import type { Notice, SocketStatus } from '@night/core/stores';
import { TableCanvas } from './TableCanvas';
import { GameOverlay } from './GameOverlay';
import { Home } from './Home';
import { Lobby } from './Lobby';

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

  // §10: the takeover screen replaces everything — reconnect only on explicit
  // user action (two tabs auto-bumping each other is a fork bomb).
  if (conn.status === 'bumped') {
    return (
      <div className="table-root">
        <TableCanvas />
        <div className="table-screen">
          <div className="bumped-screen">
            <h1>Session opened in another tab</h1>
            <p>
              This game is now running in a different tab or browser. Only one
              connection can hold the seat at a time.
            </p>
            <button className="use-here" onClick={() => appManager.connect()}>Use here</button>
          </div>
        </div>
      </div>
    );
  }

  const screen = inGame ? 'game' : inLobby ? 'lobby' : 'home';
  const showReconnect = conn.status === 'fatal' || conn.status === 'idle';

  return (
    <div className={`table-root${screen === 'game' ? ' in-game' : ''}`}>
      <TableCanvas />

      <div className="table-statusbar">
        <span className="brand">Commander Night · Table</span>
        <span className={`status status-${conn.status}`}>
          {STATUS_LABEL[conn.status]}
          {conn.status === 'dropped' && conn.attempt > 0 ? ` (attempt ${conn.attempt})` : ''}
        </span>
        {showReconnect && (
          <button className="reconnect" onClick={() => appManager.connect()}>Reconnect</button>
        )}
        {conn.lastError && conn.status !== 'ready' && <span className="conn-error">{conn.lastError}</span>}
      </div>

      {screen === 'home' && <div className="table-screen"><Home /></div>}
      {screen === 'lobby' && <div className="table-screen"><Lobby /></div>}
      {screen === 'game' && <GameOverlay />}

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
    </div>
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
