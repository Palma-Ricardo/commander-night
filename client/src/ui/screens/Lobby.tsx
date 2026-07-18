// Lobby (design §10): the code (huge, copyable, + invite URL), seat list with
// per-seat deck verdicts from lobby.state, deck textarea (persisted), ready
// toggle, host Start + fill-AI. Everything renders from lobby.state — the
// command promises only carry per-command errors inline (§11).

import { useState } from 'react';
import { useStore } from 'zustand';
import { appActions, appStores } from '../../app';
import { inviteUrl } from '../../deeplink';

export function Lobby() {
  const lobby = useStore(appStores.lobby, s => s.state);
  const userId = useStore(appStores.session, s => s.userId);
  const deckText = useStore(appStores.session, s => s.deckText);
  const [deckBusy, setDeckBusy] = useState(false);
  const [deckError, setDeckError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [fillAI, setFillAI] = useState(true);
  const [copied, setCopied] = useState<'code' | 'invite' | null>(null);

  if (!lobby) return null;
  const mySeat = lobby.seats.find(s => s.userId === userId);
  const isHost = lobby.hostUserId === userId;

  const copy = (what: 'code' | 'invite') => {
    const text = what === 'code' ? lobby.code
      : inviteUrl(`${location.origin}${location.pathname}`, lobby.code);
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const submitDeck = () => {
    setDeckBusy(true);
    setDeckError(null);
    appActions.submitDeck()
      .catch((e: Error) => setDeckError(e.message))
      .finally(() => setDeckBusy(false));
  };

  return (
    <section className="lobby">
      <div className="lobby-code">
        <span className="code">{lobby.code}</span>
        <button onClick={() => copy('code')}>{copied === 'code' ? 'copied!' : 'copy code'}</button>
        <button onClick={() => copy('invite')}>{copied === 'invite' ? 'copied!' : 'copy invite URL'}</button>
      </div>

      <ul className="seats">
        {lobby.seats.map(seat => (
          <li key={seat.userId} className="seat">
            <span className="seat-name">
              {seat.name}
              {seat.userId === lobby.hostUserId && <em> (host)</em>}
              {seat.userId === userId && <em> (you)</em>}
            </span>
            <span className={seat.ready ? 'seat-ready' : 'seat-unready'}>
              {seat.ready ? 'ready' : 'not ready'}
            </span>
            {seat.deck ? (
              seat.deck.valid ? (
                <span className="deck-ok">
                  {seat.deck.cards} cards{seat.deck.commander?.length ? ` — ${seat.deck.commander.join(' + ')}` : ''}
                </span>
              ) : (
                <ul className="deck-problems">
                  {(seat.deck.problems ?? ['deck invalid']).map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              )
            ) : (
              <span className="deck-missing">no deck yet</span>
            )}
          </li>
        ))}
        {lobby.seats.length === 0 && <li className="seat seat-empty">nobody seated yet</li>}
      </ul>

      <div className="deck-editor">
        <h2>Your deck (.dck — commander on SB: lines)</h2>
        <textarea
          value={deckText}
          rows={10}
          spellCheck={false}
          placeholder={'1 [C21:263] Command Tower\n…\nSB: 1 [KHM:222] Lathril, Blade of the Elves'}
          onChange={e => appActions.setDeckText(e.target.value)}
        />
        <div className="deck-controls">
          <button disabled={deckBusy || deckText.trim() === ''} onClick={submitDeck}>
            {deckBusy ? 'submitting…' : 'Submit deck'}
          </button>
          <label>
            <input
              type="checkbox"
              checked={mySeat?.ready ?? false}
              disabled={!mySeat?.deck?.valid}
              onChange={e => void appActions.setReady(e.target.checked).catch(() => {})}
            />
            ready
          </label>
        </div>
        {deckError && <p className="error">{deckError}</p>}
      </div>

      {isHost && (
        <div className="host-controls">
          <label>
            <input type="checkbox" checked={fillAI} onChange={e => setFillAI(e.target.checked)} />
            fill empty seats with AI
          </label>
          <button onClick={() => {
            setStartError(null);
            appActions.startGame(fillAI).catch((e: Error) => setStartError(e.message));
          }}>
            Start game
          </button>
          {startError && <p className="error">{startError}</p>}
        </div>
      )}
    </section>
  );
}
