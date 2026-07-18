// Debug panel (design §12), C0 slice: live message trace + JSONL download.
// Later milestones add seq counters, force-resync, keyframes-mode toggle,
// and the Scryfall miss list.

import { useSyncExternalStore } from 'react';
import type { Recorder, TraceEntry } from '../dev/recorder';

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
  if (typeof r['resumed'] === 'boolean') parts.push(r['resumed'] ? 'resumed' : 'fresh');
  return parts.join(' · ');
}

export function DebugPanel({ recorder }: { recorder: Recorder }) {
  const entries = useSyncExternalStore(
    l => recorder.subscribe(l),
    () => recorder.entries(),
    () => recorder.entries(),
  );

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
        <h2>Message trace</h2>
        <button onClick={download} disabled={entries.length === 0}>Download JSONL</button>
      </header>
      {entries.length === 0
        ? <p className="debug-empty">No messages yet.</p>
        : (
          <ol className="debug-trace">
            {entries.map(e => (
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
