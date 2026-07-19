// Game screen (design §8): opponents' seat panels + battlefields on top, stack
// and reveal windows mid, my battlefield and hand below, status line + prompt
// dock + turn controls in the control bar, log panel right. Post-game (§10):
// the game.over banner renders over the final keyframe; the board stays
// browsable, chat stays live through teardown grace, and the rematch flow
// (host posts the code into chat, everyone else pattern-matches it) hangs off
// the banner. Reconnects and bridge-side upstream trouble surface as a banner
// over the board (§11).

import { useState } from 'react';
import { useStore } from 'zustand';
import { appActions, appStores } from '../../app';
import { combatLines, me, opponents, playerName, statusLine } from '../../state/selectors';
import { useRematchCode } from '../log/LogPanel';
import { Battlefield } from '../board/Battlefield';
import { CardGrid, Modal } from '../board/Modal';
import { RevealPanels } from '../board/RevealPanels';
import { SeatPanel, type BrowseRequest } from '../board/SeatPanel';
import { StackPanel } from '../board/StackPanel';
import { CardView } from '../cards/CardView';
import { HoverPreview } from '../cards/HoverPreview';
import { LogPanel } from '../log/LogPanel';
import { PromptDock } from '../prompt/PromptDock';
import { TurnControls } from '../prompt/TurnControls';
import { useShortcuts } from '../shortcuts';

export function Game() {
  const game = useStore(appStores.game);
  const pendingMessage = useStore(appStores.prompt, s => s.pending?.message);
  const conn = useStore(appStores.connection);
  const [browse, setBrowse] = useState<BrowseRequest | null>(null);
  useShortcuts();

  const state = game.state;
  if (state === undefined) return null;

  const reconnecting = conn.status === 'dropped' || conn.status === 'connecting' || conn.status === 'helloSent';

  const myPlayer = me(state);
  const opps = opponents(state);
  const combat = combatLines(state);

  // XMage's reason usually already names the winner ("Player X is the winner")
  // — only append winners the reason doesn't mention.
  const winners = game.over === undefined ? [] : game.over.winnerPlayerIds
    .map(id => playerName(state, id))
    .filter(name => !game.over!.reason.includes(name));

  return (
    <div className="game">
      <div className="board">
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

        <div className="opponents">
          {opps.map(p => (
            <div key={p.id} className="opponent">
              <SeatPanel player={p} state={state} mine={false} onBrowse={setBrowse} />
              <Battlefield player={p} mine={false} />
            </div>
          ))}
        </div>

        <div className="midzone">
          <StackPanel state={state} />
          {combat.length > 0 && (
            <div className="combat-lines">
              {combat.map((line, i) => <div key={i}>⚔ {line}</div>)}
            </div>
          )}
        </div>

        <RevealPanels state={state} />

        {myPlayer !== undefined && (
          <div className="my-area">
            <SeatPanel player={myPlayer} state={state} mine onBrowse={setBrowse} />
            <Battlefield player={myPlayer} mine />
          </div>
        )}

        <div className="control-bar">
          <span className="status-line">{statusLine(state, pendingMessage)}</span>
          <TurnControls />
        </div>

        <PromptDock />

        <div className="hand">
          {state.me.hand.map((c, i) => (
            <div
              key={c.id}
              className="hand-slot"
              style={{ transform: `rotate(${(i - (state.me.hand.length - 1) / 2) * 1.5}deg)` }}
            >
              <CardView card={c} size="hand" priority={0} />
            </div>
          ))}
        </div>
      </div>

      <LogPanel state={state} />

      {browse !== null && (
        <Modal title={browse.title} onClose={() => setBrowse(null)}>
          <CardGrid cards={browse.cards} />
        </Modal>
      )}
      <HoverPreview />
    </div>
  );
}

/** §10 rematch. The host creates a fresh lobby and announces its code in the
 *  game chat; everyone else joins from that code.
 *
 *  Live-verified 2026-07-18: XMage 1.4.60 stops delivering CHATMESSAGE once
 *  GAME_OVER fires, so a post-game chat line reaches nobody — not even its
 *  sender — even though protocol §10/§14 promise the chat stays open through
 *  teardown grace. The announce is therefore best-effort and the code entry is
 *  always typeable: at a friends' night the host just reads it out. The field
 *  prefills automatically from chat, so if the bridge ever relays post-game
 *  chat the one-click path lights up again with no change here. */
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
