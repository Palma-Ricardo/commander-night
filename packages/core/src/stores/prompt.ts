// prompt store (design §4) — the pending prompt (§8: at most one per seat) plus
// the C2 interaction state around it: selection scratch (chosen targets),
// `inflight` (the single optimistic bit anywhere, §4), and the payMana
// no-progress probe (§7: a source click may not progress payment — if the
// re-ask arrives with identical `remaining`, badge the clicked source).
//
// Written by game.prompt / game.promptDone routing and by the answer-submission
// actions; components only read.

import { createStore } from 'zustand/vanilla';
import type { AnswerValue, Id, Prompt } from '../protocol/protocol';

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
  /** payMana: the T10 auto-mana solver's verdict on the pending ask
   *  (state/automana.ts) — 'paying' while it drives, 'stood-down' when it
   *  left the ask manual. Absent = solver not wired or toggle off. */
  autoPay?: 'paying' | 'stood-down';
  /** The object an inflight {object} answer acted on — gets the spinner badge (§7). */
  actedOn?: Id;
  /** Pending-intent buffer (prompts-on-the-table §4.3): a pointer-to-target
   *  release recorded ahead of its follow-up ask. Deliberately OUTSIDE
   *  emptyScratch — it must survive the prompt-arrival reset so the consumer
   *  (state/intent.ts) can judge it against the prompt that just landed; the
   *  consumer then clears it, matched or not, so it never spans two prompts. */
  intent?: { targetId: Id };
  /** The last answer this seat submitted, whatever prompt it was for. Survives
   *  the scratch reset like `intent`; read by the §5.6 rescind detector to
   *  tell a server-side rescind from the player's own Cancel. */
  lastAnswer?: AnswerValue;
}

export const emptyScratch = (): Omit<PromptStoreState, 'pending'> =>
  ({ selected: [], inflight: false, manaProbe: undefined, cantPay: [], actedOn: undefined,
     autoPay: undefined });

export const createPromptStore = () => createStore<PromptStoreState>(() => emptyScratch());
