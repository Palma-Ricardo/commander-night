// The chooseAmount selector (prompts-on-the-table §5): screen-space, centered
// — no anchor exists until M7 lands (X announcements will then sit under the
// spell like payMana). Stepper clamped to min(max,99) with free numeric input
// to the true max (which can be Integer.MAX_VALUE, §8). The OK lives in the
// corner cluster and reads this component's draft from amount-store; there is
// no cancel anywhere — the answer is required (§8, XMage re-asks forever).

import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { appStores } from '../app';
import { amountStore } from './amount-store';

export function AmountSelector() {
  const p = useStore(appStores.prompt, s => s.pending);
  if (p?.kind !== 'chooseAmount') return null;
  return <AmountPanel key={p.promptId} promptId={p.promptId} min={p.min} max={p.max} />;
}

function AmountPanel({ promptId, min, max }: { promptId: number; min: number; max: number }) {
  const [value, setValue] = useState(min);
  const stepMax = Math.min(max, 99);

  useEffect(() => {
    amountStore.setState({ draft: { promptId, value } });
  }, [promptId, value]);
  // the draft dies with the ask — a superseding prompt must not inherit it
  useEffect(() => () => amountStore.setState({ draft: undefined }), []);

  return (
    <div className="amount-selector">
      <button disabled={value <= min} onClick={() => setValue(v => v - 1)}>−</button>
      <input
        className="amount-input"
        type="number"
        autoFocus
        value={value}
        min={min}
        max={max}
        onChange={e => setValue(Number(e.target.value))}
      />
      <button disabled={value >= stepMax} onClick={() => setValue(v => v + 1)}>+</button>
    </div>
  );
}
