// Home (design §10): display name, create / join with code, #/join deep link
// prefill. Rejoin/recovery affordances land in C4.

import { useState } from 'react';
import { useStore } from 'zustand';
import { appActions, appStores } from '../../app';
import { parseJoinHash } from '../../deeplink';
import { CommandError } from '../../net/actions';

export function Home() {
  const name = useStore(appStores.session, s => s.name);
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
        </div>
      </div>

      {!ready && <p className="notice">waiting for the bridge connection…</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
