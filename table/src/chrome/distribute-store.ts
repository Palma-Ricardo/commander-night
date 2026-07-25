// distribute's view-local draft (prompts-on-the-table §5.5): the module that
// feeds the corner cluster deliberately excludes controls whose answer needs
// local input (state/prompt-controls), so the DistributePanel writes its row
// amounts here and the cluster's Submit reads them — the same shape as the
// chooseAmount draft (amount-store). Keyed by promptId: a draft for a
// superseded ask is dead on arrival.

import { createStore } from 'zustand/vanilla';
import type { Prompt } from '@night/core/protocol/protocol';

export interface DistributeDraft { promptId: number; amounts: number[] }

export const distributeStore = createStore<{ draft?: DistributeDraft }>(() => ({}));

type DistributePrompt = Extract<Prompt, { kind: 'distribute' }>;

/** Whether `amounts` satisfies the ask: every row inside its own bounds and
 *  min ≤ Σ ≤ total (§8). */
export function distributionValid(p: DistributePrompt, amounts: number[]): boolean {
  if (amounts.length !== p.among.length) return false;
  const rowsOk = p.among.every((row, i) => {
    const v = amounts[i] ?? 0;
    return v >= (row.min ?? 0) && (row.max === undefined || v <= row.max);
  });
  const sum = amounts.reduce((a, b) => a + b, 0);
  return rowsOk && sum >= p.min && sum <= p.total;
}
