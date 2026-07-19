// Game screen (design §8): opponents' seat panels + battlefields on top, stack
// and reveal windows mid, my battlefield and hand below, status line + prompt
// dock + turn controls in the control bar, log panel right. Post-game (§10):
// the game.over banner renders over the final keyframe; the board stays
// browsable.

import { useState } from 'react';
import { useStore } from 'zustand';
import { appActions, appStores } from '../../app';
import { combatLines, me, opponents, playerName, statusLine } from '../../state/selectors';
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
  const [browse, setBrowse] = useState<BrowseRequest | null>(null);
  useShortcuts();

  const state = game.state;
  if (state === undefined) return null;

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
        {game.over !== undefined && (
          <div className="over-banner">
            <b>Game over</b> — {game.over.reason}
            {winners.length > 0 && <> · winner: {winners.join(', ')}</>}
            <button className="play-again" onClick={() => appActions.leaveGame()}>
              Play again
            </button>
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
