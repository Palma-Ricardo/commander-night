// The in-game chrome (design §10): React DOM floating over the Pixi canvas. The
// board itself is the canvas (TableCanvas, mounted once at the app root); this
// overlay carries everything text-heavy and screen-anchored — the status line,
// turn controls, the prompt dock, the log/chat panel, the hover preview, the
// post-game banner + rematch, and the reconnect/upstream banners (§11). The hand
// is a canvas actor (§7.1/§10), so there is no DOM hand here.
//
// The overlay container is pointer-events:none so clicks fall through to the felt;
// each interactive island re-enables them (styles.css). Keyboard (camera + game
// shortcuts) and the background-tab nudge are mounted here, so they live only
// where a game does.

import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { appActions, appStores } from '../app';
import { playerName, statusLine } from '@night/core/state/selectors';
import { getActiveScene } from '../scene/TableScene';
import { PromptDock } from './PromptDock';
import { TurnControls } from './TurnControls';
import { LogPanel, useRematchCode } from './LogPanel';
import { HoverPreview } from './HoverPreview';
import { ManaSymbols } from './ManaSymbols';
import { useShortcuts } from './shortcuts';
import { startNudge } from './nudge';

export function GameOverlay() {
  const game = useStore(appStores.game);
  const pendingMessage = useStore(appStores.prompt, s => s.pending?.message);
  const conn = useStore(appStores.connection);
  useShortcuts();

  useEffect(() => {
    if (typeof document === 'undefined') return;
    return startNudge({ doc: document, prompt: appStores.prompt });
  }, []);

  const state = game.state;
  if (state === undefined) return null;

  const reconnecting = conn.status === 'dropped' || conn.status === 'connecting' || conn.status === 'helloSent';

  // XMage's reason usually already names the winner — only append winners the
  // reason doesn't mention.
  const winners = game.over === undefined ? [] : game.over.winnerPlayerIds
    .map(id => playerName(state, id))
    .filter(name => !game.over!.reason.includes(name));

  return (
    <div className="table-overlay">
      {(reconnecting || game.upstreamNotice !== undefined) && (
        <div className="board-banner">
          {reconnecting
            ? `reconnecting…${conn.attempt > 0 ? ` (attempt ${conn.attempt})` : ''}`
            : game.upstreamNotice}
        </div>
      )}

      {game.over !== undefined && (
        <div className="over-banner">
          <b>Game over</b> — {game.over.reason}
          {winners.length > 0 && <> · winner: {winners.join(', ')}</>}
          <RematchControls />
        </div>
      )}

      <LogPanel state={state} />

      <div className="table-controls">
        <span className="status-line">{statusLine(state, pendingMessage)}</span>
        <ManaPool />
        <Compass />
        <TurnControls />
      </div>

      <PromptDock />
      <HoverPreview />
    </div>
  );
}

const POOL_ORDER = ['W', 'U', 'B', 'R', 'G', 'C'] as const;

/** Your floating mana pool (§9). The board nameplates show only name + life, so
 *  without this the pool was invisible — you could not watch mana accumulate while
 *  paying a cost. Reads my own player's `manaPool`; shows a pip per non-zero colour
 *  and a muted placeholder when empty, so its location on the HUD is always known. */
function ManaPool() {
  const state = useStore(appStores.game, s => s.state);
  const pool = state?.players.find(p => p.id === state.me.playerId)?.manaPool;
  if (pool === undefined) return null;
  const lit = POOL_ORDER.filter(c => pool[c] > 0);
  return (
    <span className={lit.length > 0 ? 'mana-pool mana-pool-lit' : 'mana-pool'} title="your mana pool">
      {lit.length === 0
        ? <span className="mana-pool-empty">pool empty</span>
        : lit.map(c => (
            <span key={c} className="mana-pool-pip">{pool[c]}<ManaSymbols symbols={[c]} /></span>
          ))}
    </span>
  );
}

/** Camera compass (§7.3): jump to the whole table or a seat, or resume follow.
 *  The camera lives in the scene/director (not a store), so these just issue
 *  imperative commands; the live Following/Viewing badge is a T4 polish item. */
function Compass() {
  const scene = () => getActiveScene();
  return (
    <span className="compass" title="camera — keys 1–4 / ` table / Esc follow">
      <button data-cam="table" onClick={() => scene()?.showTable()}>Table</button>
      {[1, 2, 3, 4].map(n => (
        <button key={n} data-cam={`seat-${n - 1}`} onClick={() => scene()?.focusSeat(n - 1)}>{n}</button>
      ))}
      <button data-cam="follow" onClick={() => scene()?.releaseCamera()}>Follow</button>
    </span>
  );
}

/** §10 rematch. The host creates a fresh lobby and announces its code in the game
 *  chat; everyone else joins from that code. Ported from the classic Game screen.
 *
 *  Live-verified 2026-07-18: XMage 1.4.60 stops delivering CHATMESSAGE once
 *  GAME_OVER fires, so a post-game chat line reaches nobody — the announce is
 *  best-effort and the code entry is always typeable (at a friends' night the
 *  host just reads it out). The field prefills from chat, so if the bridge ever
 *  relays post-game chat the one-click path lights up again with no change. */
function RematchControls() {
  const announced = useRematchCode();
  const userId = useStore(appStores.session, s => s.userId);
  const hostUserId = useStore(appStores.lobby, s => s.state?.hostUserId);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    fn().catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };

  const code = (typed.trim() === '' ? announced ?? '' : typed).toUpperCase();
  const mayHost = hostUserId === undefined || hostUserId === userId;

  return (
    <span className="rematch-controls">
      {mayHost && (
        <button className="rematch" disabled={busy} onClick={() => run(() => appActions.rematch())}>
          Rematch
        </button>
      )}
      <span className="join-rematch-field">
        <input
          className="rematch-code"
          value={code}
          placeholder="rematch code"
          size={12}
          onChange={e => setTyped(e.target.value.toUpperCase())}
        />
        <button
          className="join-rematch"
          disabled={busy || code === ''}
          onClick={() => run(() => appActions.joinRematch(code))}
        >
          Join rematch
        </button>
      </span>
      <button className="play-again" disabled={busy} onClick={() => appActions.leaveGame()}>
        Leave
      </button>
      {error && <span className="error">{error}</span>}
    </span>
  );
}
