// App shell: the screen pipeline (design §1/§10) — home → lobby → game — driven
// entirely by stores. postGame is folded into the game stub until C4.

import { useStore } from 'zustand';
import { appManager, appStores } from '../app';
import type { SocketStatus } from '../stores';
import { DebugPanel } from './DebugPanel';
import { GameStub } from './screens/GameStub';
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

  const screen = inGame ? 'game' : inLobby ? 'lobby' : 'home';
  const showReconnect = conn.status === 'bumped' || conn.status === 'fatal' || conn.status === 'idle';

  return (
    <main className="app">
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
      {screen === 'game' && <GameStub />}

      <DebugPanel />
    </main>
  );
}
