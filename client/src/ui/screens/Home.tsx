// Home (design §10): display name, create / join with code, #/join deep link
// prefill, and the rejoin affordances — "Return to game" for a live resume
// anchor, and the recovery path (join a running game with your seat name to
// take the seat back — the lost-token flow, protocol §5/§14).

import { useState } from 'react';
import { useStore } from 'zustand';
import { appActions, appStores } from '../../app';
import { parseJoinHash } from '@night/core/deeplink';
import { CommandError } from '@night/core/net/actions';

export function Home() {
  const name = useStore(appStores.session, s => s.name);
  const resume = useStore(appStores.session, s => s.resume);
  const ready = useStore(appStores.connection, s => s.status === 'ready');
  const [code, setCode] = useState(() =>
    typeof location !== 'undefined' ? (parseJoinHash(location.hash) ?? '') : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    fn().catch((e: unknown) => {
      setError(e instanceof CommandError || e instanceof Error ? e.message : String(e));
    }).finally(() => setBusy(false));
  };

  const canAct = ready && !busy && name.trim().length > 0;

  return (
    <section className="home">
      {resume !== undefined && (
        <div className="rejoin">
          <p>You have a game in progress.</p>
          <button disabled={busy} onClick={() => run(() => appActions.returnToGame())}>
            Return to game
          </button>
        </div>
      )}

      <label className="field">
        <span>Display name</span>
        <input
          value={name}
          placeholder="how the table sees you"
          onChange={e => appActions.setDisplayName(e.target.value)}
        />
      </label>

      <div className="home-split">
        <div className="home-card">
          <h2>Host a table</h2>
          <button disabled={!canAct} onClick={() => run(() => appActions.createLobby())}>
            Create lobby
          </button>
        </div>
        <div className="home-card">
          <h2>Join with code</h2>
          <input
            value={code}
            placeholder="XKCD42"
            autoFocus={code !== ''}
            onChange={e => setCode(e.target.value.toUpperCase())}
          />
          <button
            disabled={!canAct || code.trim() === ''}
            onClick={() => run(() => appActions.joinLobby(code))}
          >
            Join
          </button>
          <p className="hint">
            Rejoining a game already in progress? Enter its code and your seat
            name — you take your seat back, mid-game.
          </p>
        </div>
      </div>

      {!ready && <p className="notice">waiting for the bridge connection…</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
