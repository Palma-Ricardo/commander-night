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
import type { GameState } from '@night/core/protocol/protocol';
import { playerName, stepLabel } from '@night/core/state/selectors';
import { getActiveScene } from '../scene/TableScene';
import { displaySeats, seatOfPlayer } from '../layout/world';
import { cameraHudStore } from './camera-store';
import { CornerCluster } from './CornerCluster';
import { InstructionLine } from './InstructionLine';
import { AmountSelector } from './AmountSelector';
import { AbilityOptions } from './AbilityOptions';
import { OptionTiles } from './OptionTiles';
import { PileChoice } from './PileChoice';
import { DistributePanel } from './DistributePanel';
import { PayPanel } from './PayPanel';
import { RequestPanel } from './RequestPanel';
import { CarouselBar } from './CarouselBar';
import { TurnControls } from './TurnControls';
import { LogPanel, useRematchCode } from './LogPanel';
import { HoverPreview } from './HoverPreview';
import { ManaSymbols } from './ManaSymbols';
import { useShortcuts } from './shortcuts';
import { startNudge } from './nudge';

export function GameOverlay() {
  const game = useStore(appStores.game);
  useShortcuts();

  useEffect(() => {
    if (typeof document === 'undefined') return;
    return startNudge({ doc: document, prompt: appStores.prompt });
  }, []);

  const state = game.state;
  if (state === undefined) return null;

  // XMage's reason usually already names the winner — only append winners the
  // reason doesn't mention.
  const winners = game.over === undefined ? [] : game.over.winnerPlayerIds
    .map(id => playerName(state, id))
    .filter(name => !game.over!.reason.includes(name));

  return (
    <div className="table-overlay">
      <BoardBanner />

      {game.over !== undefined && (
        <div className="over-banner">
          <b>Game over</b> — {game.over.reason}
          {winners.length > 0 && <> · winner: {winners.join(', ')}</>}
          <RematchControls />
        </div>
      )}

      <Ribbon state={state} />
      <InstructionLine />
      <Camstate />

      <div className="hud-topright">
        <Compass />
      </div>

      <LogPanel state={state} />

      <ManaPool />

      {/* Screen-space prompt surfaces (prompts-on-the-table §5) — each gates on
          its own kind, so at most one is up. The carousel's cards are canvas
          (TableScene); its bar is the only DOM the fan has (the hand scrolls on
          the canvas itself now, #8). */}
      <AmountSelector />
      <AbilityOptions />
      <OptionTiles />
      <PileChoice />
      <DistributePanel />
      <CarouselBar />

      <div className="dock-corner">
        <TurnControls />
        <PayPanel />
        <RequestPanel />
        <CornerCluster />
      </div>

      <HoverPreview />
    </div>
  );
}

/** How long a bridge-side upstream notice lingers before it clears itself (§11).
 *  The notice used to hang around until the next status line or keyframe — minutes
 *  in a quiet game — so it now auto-expires and can be dismissed by hand. */
const UPSTREAM_NOTICE_MS = 30_000;

/** §11 board banner: reconnect status and bridge-side upstream-trouble notices,
 *  both pinned top-centre over the felt. The reconnect variant mirrors live
 *  connection state, so it self-clears and carries no controls. The upstream
 *  notice is advisory and otherwise sticky, so it auto-expires after
 *  UPSTREAM_NOTICE_MS and shows a dismiss control. */
function BoardBanner() {
  const conn = useStore(appStores.connection);
  const notice = useStore(appStores.game, s => s.upstreamNotice);
  const reconnecting = conn.status === 'dropped' || conn.status === 'connecting' || conn.status === 'helloSent';

  useEffect(() => {
    if (notice === undefined) return;
    const t = setTimeout(() => appStores.game.setState({ upstreamNotice: undefined }), UPSTREAM_NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  if (!reconnecting && notice === undefined) return null;

  return (
    <div className="board-banner">
      {reconnecting
        ? `reconnecting…${conn.attempt > 0 ? ` (attempt ${conn.attempt})` : ''}`
        : notice}
      {!reconnecting && (
        <button
          className="banner-dismiss"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => appStores.game.setState({ upstreamNotice: undefined })}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** The turn ribbon (top-centre, §7.3): whose turn and which step. Lifted out of
 *  the prompt dock so a pending prompt's message can never sit on top of the turn
 *  counter — they now live in different corners. */
function Ribbon({ state }: { state: GameState }) {
  return (
    <div className="ribbon">
      <span>Turn {state.turn.n}</span>
      <span className="sep">·</span>
      <b>{playerName(state, state.turn.activePlayerId)}</b>
      <span className="sep">·</span>
      <span>{stepLabel(state.turn.step)}</span>
    </div>
  );
}

const POOL_ORDER = ['W', 'U', 'B', 'R', 'G', 'C'] as const;

/** Your floating mana pool (§9): a screen-space window pinned bottom-left, out of
 *  the old prompt bar. The board nameplates show only name + life, so without this
 *  the pool was invisible — you could not watch mana accumulate while paying a
 *  cost. Reads my own player's `manaPool`; a pip per non-zero colour, a muted
 *  placeholder when empty, so its home on the HUD is always known. */
function ManaPool() {
  const state = useStore(appStores.game, s => s.state);
  const pool = state?.players.find(p => p.id === state.me.playerId)?.manaPool;
  if (pool === undefined) return null;
  const lit = POOL_ORDER.filter(c => pool[c] > 0);
  return (
    <div className="mana-pool-window" title="your mana pool">
      <h4>Mana pool</h4>
      <div className={lit.length > 0 ? 'mana-pool mana-pool-lit' : 'mana-pool'}>
        {lit.length === 0
          ? <span className="mana-pool-empty">empty</span>
          : lit.map(c => (
              <span key={c} className="mana-pool-pip">{pool[c]}<ManaSymbols symbols={[c]} /></span>
            ))}
      </div>
    </div>
  );
}

// The compass 2×2 mirrors the table's quadrants (world.ts CORNER_BY_DISPLAY):
// display 0 = you bottom-left, 1 top-left, 2 top-right, 3 bottom-right — turn
// order clockwise (§7.2). Read in grid order [TL, TR, BL, BR] that is [1, 2, 0, 3].
const COMPASS_CELLS = [1, 2, 0, 3] as const;

/** Camera compass (§7.3): a live 2×2 minimap of the table. Each cell is a seat
 *  with its life; the active player lights brass (`data-turn`), the seat the lens
 *  is holding is `aria-current`. Clicking a cell pins that seat, "Whole table"
 *  pulls back — the imperative moves the old button row issued, but now you can
 *  read where the camera is from the map itself. */
function Compass() {
  const state = useStore(appStores.game, s => s.state);
  const view = useStore(cameraHudStore, s => s.view);
  if (state === undefined) return null;
  const seats = displaySeats(state);
  const activeSeat = seatOfPlayer(state, state.turn.activePlayerId);
  const viewedSeat = view.kind === 'seat' ? view.seat : -1;
  const scene = () => getActiveScene();
  return (
    <nav className="compass" aria-label="Move the camera — keys 1–4, ` whole table, Esc follow">
      <h3>Viewport</h3>
      <div className="compass-grid">
        {COMPASS_CELLS.map(d => {
          const p = seats[d];
          if (p === undefined) return <span key={d} className="cq cq-empty" aria-hidden="true" />;
          return (
            <button
              key={d}
              className="cq"
              data-cam={`seat-${d}`}
              data-turn={d === activeSeat ? '1' : undefined}
              aria-current={d === viewedSeat}
              onClick={() => scene()?.focusSeat(d)}
            >
              <span className="cq-nm">{p.name}</span>
              <b>{p.life}</b>
            </button>
          );
        })}
        <button
          className="cq-all"
          data-cam="table"
          aria-current={view.kind === 'table'}
          onClick={() => scene()?.showTable()}
        >
          Whole table
        </button>
      </div>
    </nav>
  );
}

/** The camera override badge (§7.3): shown only when the lens is manually pinned
 *  off its default follow. Reads the camera-store; in follow mode it renders
 *  nothing (the compass already lights the followed seat). Esc releases it. */
function Camstate() {
  const state = useStore(appStores.game, s => s.state);
  const { view, following } = useStore(cameraHudStore);
  if (state === undefined || following) return null;
  const target = view.kind === 'seat'
    ? playerName(state, displaySeats(state)[view.seat]?.id)
    : 'the whole table';
  return (
    <div className="camstate">
      <span className="dot manual" />
      <span>Viewing <b>{target}</b></span>
      <span className="hint">Esc</span>
    </div>
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
