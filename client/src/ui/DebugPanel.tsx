// Debug panel (design §12): live message trace + JSONL download, seq counters,
// keyframes-mode toggle (next connect), force resync. Scryfall miss list lands
// with images in C2.

import { useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { appActions, appManager, appStores } from '../app';
import { recorder } from '../dev/recorder';
import type { TraceEntry } from '../dev/recorder';

function describe(entry: TraceEntry): string {
  const m = entry.msg;
  if (typeof m !== 'object' || m === null) return String(m);
  const r = m as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof r['t'] === 'string') parts.push(r['t']);
  if (typeof r['decodeError'] === 'string') parts.push(`DECODE ERROR: ${r['decodeError']}`);
  if (typeof r['ignoredType'] === 'string') parts.push(`ignored: ${r['ignoredType']}`);
  if (typeof r['seq'] === 'number') parts.push(`seq ${r['seq']}`);
  if (typeof r['id'] === 'string') parts.push(`id ${r['id']}`);
  if (typeof r['re'] === 'string') parts.push(`re ${r['re']}`);
  if (typeof r['kind'] === 'string') parts.push(String(r['kind']));
  if (typeof r['code'] === 'string') parts.push(String(r['code']));
  if (typeof r['resumed'] === 'boolean') parts.push(r['resumed'] ? 'resumed' : 'fresh');
  return parts.join(' · ');
}

export function DebugPanel() {
  const entries = useSyncExternalStore(
    l => recorder.subscribe(l),
    () => recorder.entries(),
    () => recorder.entries(),
  );
  const game = useStore(appStores.game, s => s);
  const keyframesMode = useStore(appStores.settings, s => s.keyframesMode);

  const download = () => {
    const blob = new Blob([recorder.toJsonl()], { type: 'application/jsonl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `night-session-${Date.now()}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="debug-panel">
      <header>
        <h2>Debug</h2>
        <span className="debug-meta">
          seq {game.lastAppliedSeq} · {game.syncMode}
        </span>
        <label title="hello stateMode:'keyframes' — applies on the next connect (§6)">
          <input type="checkbox" checked={keyframesMode} onChange={() => appActions.toggleKeyframesMode()} />
          keyframes mode
        </label>
        <button onClick={() => appManager.resyncNow()}>Force resync</button>
        <button onClick={download} disabled={entries.length === 0}>Download JSONL</button>
      </header>
      {entries.length === 0
        ? <p className="debug-empty">No messages yet.</p>
        : (
          <ol className="debug-trace">
            {entries.slice(-200).map(e => (
              <li key={e.n} className={e.dir === 'in' ? 'trace-in' : 'trace-out'}>
                <span className="trace-dir">{e.dir === 'in' ? '←' : '→'}</span>
                <span className="trace-desc">{describe(e)}</span>
                <span className="trace-ts">{new Date(e.ts).toLocaleTimeString()}</span>
              </li>
            ))}
          </ol>
        )}
    </section>
  );
}
