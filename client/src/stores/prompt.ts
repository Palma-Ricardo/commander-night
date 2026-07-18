// prompt store (design §4) — the pending prompt (§8: at most one per seat) plus
// the C2 interaction state around it: selection scratch (chosen targets),
// `inflight` (the single optimistic bit anywhere, §4), and the payMana
// no-progress probe (§7: a source click may not progress payment — if the
// re-ask arrives with identical `remaining`, badge the clicked source).
//
// Written by game.prompt / game.promptDone routing and by the answer-submission
// actions; components only read.

import { createStore } from 'zustand/vanilla';
import type { Id, Prompt } from '../protocol/protocol';

export interface PromptStoreState {
  pending?: Prompt;
  /** chooseTargets accumulation; submitted whole as {objects} (§8). */
  selected: Id[];
  /** Set on answer submit; cleared by promptDone or a superseding prompt (§7). */
  inflight: boolean;
  /** payMana: the source clicked on the current ask, to detect a no-progress re-ask. */
  manaProbe?: { sourceId: Id; remaining: string };
  /** payMana: sources that provably can't pay the current remaining cost. */
  cantPay: Id[];
  /** The object an inflight {object} answer acted on — gets the spinner badge (§7). */
  actedOn?: Id;
}

export const emptyScratch = (): Omit<PromptStoreState, 'pending'> =>
  ({ selected: [], inflight: false, manaProbe: undefined, cantPay: [], actedOn: undefined });

export const createPromptStore = () => createStore<PromptStoreState>(() => emptyScratch());
