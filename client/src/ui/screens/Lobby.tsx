// Lobby (design §10): the code (huge, copyable, + invite URL), seat list with
// per-seat deck verdicts from lobby.state, deck textarea (persisted), ready
// toggle, host Start + fill-AI. Everything renders from lobby.state — the
// command promises only carry per-command errors inline (§11).

import { useState } from 'react';
import { useStore } from 'zustand';
import { appActions, appStores } from '../../app';
import { inviteUrl } from '../../deeplink';
import type { LobbyState } from '../../protocol/protocol';
import { deckView } from './deck-view';

/** One seat's deck verdict. Thin shell over `deckView` — see that module for why
 *  commander names render individually, and on invalid decks too. */
function DeckVerdict({ deck, own }: {
  deck: LobbyState['seats'][number]['deck'];
  own: boolean;
}) {
  const view = deckView(deck, { own });
  if (view.kind === 'none') return <span className="deck-missing">no deck yet</span>;
  return (
    <span className="deck-status">
      <span className={view.kind === 'valid' ? 'deck-ok' : 'deck-bad'}>
        {view.cards} cards
        {view.format !== undefined && <em className="deck-format">{view.format}</em>}
      </span>
      {/* The Moxfield commander inference can false-positive and still pass every
          legality check, so these names are the only place a human catches it.
          One element per name — protocol §5 forbids a joined summary. */}
      {view.commanders.length > 0 && (
        <ul
          className="deck-commanders"
          aria-label={view.commanders.length > 1 ? 'detected commanders' : 'detected commander'}
        >
          {view.commanders.map((name, i) => <li key={`${i}-${name}`}>{name}</li>)}
        </ul>
      )}
      {view.problems.length > 0 && (
        <ul className="deck-problems">
          {view.problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}
      {view.warnings.length > 0 && (
        <ul className="deck-warnings">
          {view.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
    </span>
  );
}

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
            <DeckVerdict deck={seat.deck} own={seat.userId === userId} />
          </li>
        ))}
        {lobby.seats.length === 0 && <li className="seat seat-empty">nobody seated yet</li>}
      </ul>

      <div className="deck-editor">
        <h2>Your deck</h2>
        <p className="deck-hint">
          Paste a Moxfield export, an MTGO list, or an XMage .dck — the format is detected
          for you. Check the commander names it reports back.
        </p>
        <textarea
          value={deckText}
          rows={10}
          spellCheck={false}
          placeholder={'1 Rose Tyler (WHO) 5\n1 The Tenth Doctor (WHO) 3\n1 Sol Ring (WHO) 245\n…'}
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
