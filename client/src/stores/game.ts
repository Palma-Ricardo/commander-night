// game store (design §4) — canonical GameState + sync bookkeeping. Written by
// the keyframe/patch/resync flow. C1 is keyframes-only: syncMode
// 'awaitingKeyframe' gates out patches until state/apply.ts lands (C3).

import { createStore } from 'zustand/vanilla';
import type { GameOver, GameState } from '../protocol/protocol';

export interface GameStoreState {
  state?: GameState;
  lastAppliedSeq: number;      // -1 before the first keyframe
  syncMode: 'live' | 'awaitingKeyframe';
  over?: GameOver;
}

export const createGameStore = () =>
  createStore<GameStoreState>(() => ({ lastAppliedSeq: -1, syncMode: 'live' }));
