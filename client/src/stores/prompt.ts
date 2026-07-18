// prompt store (design §4) — the pending prompt (§8: at most one per seat).
// Written by game.prompt / game.promptDone. Selection scratch + inflight land
// with the prompt dock in C2.

import { createStore } from 'zustand/vanilla';
import type { Prompt } from '../protocol/protocol';

export interface PromptStoreState { pending?: Prompt }

export const createPromptStore = () => createStore<PromptStoreState>(() => ({}));
