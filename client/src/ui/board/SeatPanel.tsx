// Seat panel (§8): name, life (+flags), counters, mana pool (non-zero only),
// zone counts, command zone with tax badge, graveyard/exile piles opening the
// browser modal. Commander damage renders on the life total's expand — the
// data lives on the victim (protocol §6), which is how players ask ("how much
// am I on?"). The whole panel is a click target when the player is a prompt
// candidate (chooseTargets can target players).

import { useState } from 'react';
import { useStore } from 'zustand';
import { appStores } from '../../app';
import type { Card, GameState, Player } from '@night/core/protocol/protocol';
import { affordanceFor, commanderDamageRows } from '@night/core/state/selectors';
import { CardView } from '../cards/CardView';
import { ManaSymbols } from '../cards/ManaSymbols';
import { objectClick } from './interact';

export interface BrowseRequest { title: string; cards: Card[] }

interface Props {
  player: Player;
  state: GameState;
  mine: boolean;
  onBrowse(req: BrowseRequest): void;
}

const POOL_ORDER = ['W', 'U', 'B', 'R', 'G', 'C'] as const;

export function SeatPanel({ player, state, mine, onBrowse }: Props) {
  const prompt = useStore(appStores.prompt);
  const [expanded, setExpanded] = useState(false);
  const aff = affordanceFor(prompt, player.id);
  const active = state.turn.activePlayerId === player.id;
  const dmgRows = commanderDamageRows(state, player);
  const pool = POOL_ORDER.filter(c => player.manaPool[c] > 0);

  const classes = ['seat-panel'];
  if (mine) classes.push('seat-mine');
  if (active) classes.push('seat-active');
  if (player.flags?.dead === true || player.flags?.left === true) classes.push('seat-out');
  if (aff?.kind === 'target') classes.push('hl-target');
  if (aff?.kind === 'target' && aff.selected) classes.push('card-selected');

  return (
    <div
      className={classes.join(' ')}
      data-player-name={player.name}
      onClick={aff !== undefined ? () => objectClick(prompt, player.id) : undefined}
      role={aff !== undefined ? 'button' : undefined}
    >
      <div className="seat-head">
        <span className="seat-title">
          {active && <span className="turn-marker" title="active player">▶</span>}
          {player.name}
          {!player.human && <span className="seat-ai" title="AI">🤖</span>}
          {player.flags?.monarch === true && <span title="monarch">👑</span>}
          {player.flags?.initiative === true && <span title="has the initiative">🗡</span>}
          {player.flags?.dead === true && <span title="dead">💀</span>}
          {player.flags?.left === true && <span title="left the game">🚪</span>}
        </span>
        <button
          className="seat-life"
          title="life — click for commander damage"
          onClick={e => { e.stopPropagation(); setExpanded(x => !x); }}
        >
          {player.life}
        </button>
      </div>

      <div className="seat-meta">
        <span title="library">📚 {player.librarySize}</span>
        <span title="hand">✋ {player.handSize}</span>
        {(player.counters ?? []).map(c => (
          <span key={c.name} className="player-counter" title={c.name}>{c.name} {c.count}</span>
        ))}
        {pool.length > 0 && (
          <span className="seat-pool" title="mana pool">
            {pool.map(c => <span key={c}>{player.manaPool[c]}<ManaSymbols symbols={[c]} /></span>)}
          </span>
        )}
        {player.timer !== undefined && (
          <span className={`seat-timer ${player.timer.active ? 'timer-active' : ''}`}>
            ⏱ {Math.floor(player.timer.remainingSecs / 60)}:{String(player.timer.remainingSecs % 60).padStart(2, '0')}
          </span>
        )}
      </div>

      {expanded && (
        <div className="cmd-damage">
          {dmgRows.length === 0
            ? <span className="muted">no commander damage</span>
            : dmgRows.map(r => <span key={r.commander}>{r.commander}: <b>{r.amount}</b></span>)}
        </div>
      )}

      <div className="seat-zones">
        {player.commandZone.map(co => (
          <CardView
            key={co.id}
            card={co}
            size="small"
            priority={0}
            badge={co.kind === 'commander'
              ? <span className="badge badge-tax" title="commander tax">+{2 * (co.castCount ?? 0)}</span>
              : undefined}
          />
        ))}
        <button
          className="pile-btn"
          disabled={player.graveyard.length === 0}
          onClick={e => { e.stopPropagation(); onBrowse({ title: `${player.name} — graveyard`, cards: player.graveyard }); }}
        >
          GY {player.graveyard.length}
        </button>
        <button
          className="pile-btn"
          disabled={player.exile.length === 0}
          onClick={e => { e.stopPropagation(); onBrowse({ title: `${player.name} — exile`, cards: player.exile }); }}
        >
          Exile {player.exile.length}
        </button>
      </div>
    </div>
  );
}
