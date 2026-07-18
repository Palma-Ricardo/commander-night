// settings store (design §12) — debug toggles, persisted under cn.settings.

import { createStore } from 'zustand/vanilla';
import { KEYS, type KV } from './storage';

export interface SettingsState {
  keyframesMode: boolean;      // §6: hello sends stateMode:'keyframes'. Default ON
                               // for C1/C2 development; default flips when patch
                               // mode lands in C3.
}

export const createSettingsStore = (kv: KV) =>
  createStore<SettingsState>(() => {
    const raw = kv.get(KEYS.settings);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as Partial<SettingsState>;
        if (typeof parsed.keyframesMode === 'boolean') return { keyframesMode: parsed.keyframesMode };
      } catch {
        kv.remove(KEYS.settings);
      }
    }
    return { keyframesMode: true };
  });
