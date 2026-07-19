// game store (design §4) — canonical GameState + sync bookkeeping. Written by
// the keyframe/patch/resync flow (state/apply.ts) via route.

import { createStore } from 'zustand/vanilla';
import type { GameOver, GameState } from '../protocol/protocol';

/** Sync-discipline counters (design §12 debug panel; the C3 auto-player asserts
 *  resyncs and divergences stay 0 over a whole game). */
export interface SyncCounters {
  patches: number;       // patches applied
  keyframes: number;     // keyframes received
  resyncs: number;       // client-triggered by the §6 discipline (base mismatch / failed op)
  verifies: number;      // dev keyframe-verify runs (§6)
  divergences: number;   // verify mismatches — any nonzero is a codec/patch bug
}

export const emptyCounters = (): SyncCounters =>
  ({ patches: 0, keyframes: 0, resyncs: 0, verifies: 0, divergences: 0 });

export interface GameStoreState {
  state?: GameState;
  lastAppliedSeq: number;      // -1 before the first keyframe
  /** True when the event at lastAppliedSeq was a patch: the §6 verify only
   *  probes a keyframe riding directly behind a patch (the backstop pair) —
   *  after keyframes/resyncs the local tree is a new baseline, not a claim. */
  lastAppliedWasPatch: boolean;
  syncMode: 'live' | 'awaitingKeyframe';
  counters: SyncCounters;
  /** protocol §9 autoMana — no state echo exists, so this is the ack-confirmed
   *  last value we sent; server default is ON. */
  autoMana: boolean;
  over?: GameOver;
}

export const freshGame = (): GameStoreState => ({
  state: undefined,
  over: undefined,
  lastAppliedSeq: -1,
  lastAppliedWasPatch: false,
  syncMode: 'live',
  counters: emptyCounters(),
  autoMana: true,
});

export const createGameStore = () => createStore<GameStoreState>(() => freshGame());
