// distribute's surface (prompts-on-the-table §5.5), the chip fallback: one
// labeled chip per row, click to increment (wrapping to the row's min past its
// max), right-click to decrement, with a running Σ tally against the ask's
// bounds. Submit lives in the corner cluster and reads the draft from
// distribute-store; Cancel (when `canCancel`) is the cluster's secondary.
// Caveat carried from §8: this kind has never been observed live — the surface
// ships fixture-driven until it fires at a real table. The on-permanent
// click-to-increment (rows with M7's `objectId`) waits for that first live
// sighting; the chips are the guaranteed path either way.

import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useStore } from 'zustand';
import { appStores } from '../app';
import type { Prompt } from '@night/core/protocol/protocol';
import { distributeStore, distributionValid } from './distribute-store';

type DistributePrompt = Extract<Prompt, { kind: 'distribute' }>;

export function DistributePanel() {
  const prompt = useStore(appStores.prompt);
  const p = prompt.pending;
  if (p?.kind !== 'distribute') return null;
  return <Panel key={p.promptId} p={p} busy={prompt.inflight} />;
}

function Panel({ p, busy }: { p: DistributePrompt; busy: boolean }) {
  const [amounts, setAmounts] = useState<number[]>(() =>
    p.among.map(row => row.suggested ?? row.min ?? 0));
  const sum = amounts.reduce((a, b) => a + b, 0);
  const valid = distributionValid(p, amounts);

  useEffect(() => {
    distributeStore.setState({ draft: { promptId: p.promptId, amounts } });
  }, [p.promptId, amounts]);
  // the draft dies with the ask — a superseding prompt must not inherit it
  useEffect(() => () => distributeStore.setState({ draft: undefined }), []);

  const bump = (i: number, dir: 1 | -1): void => {
    if (busy) return;
    const row = p.among[i]!;
    const lo = row.min ?? 0;
    const hi = row.max ?? p.total;
    setAmounts(a => a.map((v, j) => {
      if (j !== i) return v;
      const next = v + dir;
      return next > hi ? lo : next < lo ? hi : next;   // wrap both ways (§5.5)
    }));
  };

  return (
    <div className={`distribute-panel${busy ? ' dock-busy' : ''}`}>
      <div className="distribute-chips">
        {p.among.map((row, i) => (
          <button
            key={row.id}
            className="distribute-chip"
            data-row={row.id}
            disabled={busy}
            title="click +1 · right-click −1"
            onClick={() => bump(i, 1)}
            onContextMenu={(e: ReactMouseEvent) => { e.preventDefault(); bump(i, -1); }}
          >
            <span className="chip-label">{row.label}</span>
            <b className="chip-count">{amounts[i]}</b>
          </button>
        ))}
      </div>
      <p className={valid ? 'muted' : 'error'}>
        total {sum} (need {p.min === p.total ? p.total : `${p.min}–${p.total}`})
      </p>
    </div>
  );
}
