// App shell: the screen pipeline (design §1/§10) — home → lobby → game — driven
// entirely by stores. postGame is folded into the game screen until C4. Debug
// panel behind `?debug` or the backtick toggle (design §12).

import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { appManager, appStores } from '../app';
import type { SocketStatus } from '../stores';
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

  const screen = inGame ? 'game' : inLobby ? 'lobby' : 'home';
  const showReconnect = conn.status === 'bumped' || conn.status === 'fatal' || conn.status === 'idle';

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

      {showDebug && <DebugPanel />}
    </main>
  );
}
