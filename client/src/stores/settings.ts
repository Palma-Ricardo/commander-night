// settings store (design §12) — debug toggles, persisted under cn.settings.

import { createStore } from 'zustand/vanilla';
import { KEYS, type KV } from './storage';

export interface SettingsState {
  keyframesMode: boolean;      // §6 debug escape hatch: hello sends
                               // stateMode:'keyframes'. Default OFF since C3 —
                               // patch mode is the real protocol.
}

/** Persisted-shape version. Bumped to 3 at C3: earlier persists could carry
 *  keyframesMode:true from when that was the development default — honoring
 *  them would silently pin a browser to the debug mode and bypass the entire
 *  patch pipeline. Older/unversioned persists are discarded. */
const SETTINGS_V = 3;

export function persistSettings(kv: KV, state: SettingsState): void {
  kv.set(KEYS.settings, JSON.stringify({ v: SETTINGS_V, ...state }));
}

export const createSettingsStore = (kv: KV) =>
  createStore<SettingsState>(() => {
    const raw = kv.get(KEYS.settings);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as Partial<SettingsState> & { v?: number };
        if (parsed.v === SETTINGS_V && typeof parsed.keyframesMode === 'boolean') {
          return { keyframesMode: parsed.keyframesMode };
        }
        kv.remove(KEYS.settings);   // stale shape — defaults win
      } catch {
        kv.remove(KEYS.settings);
      }
    }
    return { keyframesMode: false };
  });
