// Game screen, C1 stub (design §14 C1 exit: "a stub game screen with live
// keyframes rendering as raw state"). C2 replaces this with the real board.

import { useStore } from 'zustand';
import { appStores } from '../../app';

export function GameStub() {
  const game = useStore(appStores.game, s => s);
  const prompt = useStore(appStores.prompt, s => s.pending);
  const entries = useStore(appStores.log, s => s.entries);

  const state = game.state;
  if (!state) return null;

  const byId = new Map(state.players.map(p => [p.id, p.name]));
  const name = (id: string | undefined) => (id !== undefined ? (byId.get(id) ?? id) : '—');
  // phase/step absent = the pre-game mulligan window (protocol §6)
  const phase = state.turn.phase !== undefined ? `${state.turn.phase}/${state.turn.step}` : 'Mulligans';

  return (
    <section className="game-stub">
      <p className="status-line">
        Turn {state.turn.n} · {phase} · active: {name(state.turn.activePlayerId)} ·
        priority: {name(state.turn.priorityPlayerId)} · seq {game.lastAppliedSeq}
      </p>

      {game.over && (
        <div className="over-banner">
          Game over — {game.over.reason} (winners: {
            game.over.winnerPlayerIds.map(id => byId.get(id) ?? id).join(', ') || 'none'
          })
        </div>
      )}

      {prompt && (
        <div className="prompt-raw">
          <h3>pending prompt (answering lands in C2)</h3>
          <pre>{JSON.stringify(prompt, null, 2)}</pre>
        </div>
      )}

      <div className="log-tail">
        <h3>log</h3>
        <ul>
          {entries.slice(-20).map(e => (
            <li key={e.seq} className={`log-${e.kind}`}>
              {e.turn !== undefined ? `[${e.turn}] ` : ''}{e.text}
            </li>
          ))}
        </ul>
      </div>

      <details open className="raw-state">
        <summary>raw GameState (stub view — the C2 board replaces this)</summary>
        <pre>{JSON.stringify(state, null, 2)}</pre>
      </details>
    </section>
  );
}
