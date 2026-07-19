// Composition root: the app's store/manager/action singletons. React imports
// from here; tests and headless runs build their own stacks via the factories.

import { recorder } from './dev/recorder';
import { createScryfallResolver } from './images/scryfall';
import { createActions } from './net/actions';
import { createSocketManager } from './net/socket';
import { createStores } from './stores';
import { browserKV } from './stores/storage';

function bridgeUrl(): string {
  const configured = import.meta.env.VITE_BRIDGE_WS as string | undefined;
  if (configured) return configured;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;   // dev: Vite proxies /ws → 127.0.0.1:8484
}

export const appKV = browserKV();
export const appStores = createStores(appKV);
export const appManager = createSocketManager({
  stores: appStores,
  kv: appKV,
  recorder,
  url: bridgeUrl(),
  strictDecode: import.meta.env.DEV,
  devVerify: import.meta.env.DEV,
});
export const appScryfall = createScryfallResolver({ kv: appKV });
export const appActions = createActions(appStores, appManager, appKV, { scryfall: appScryfall });

export function bootApp(): void {
  appManager.connect();
}

// Dev-only introspection handle for the Playwright auto-player (design §13):
// reads only — the auto-player drives the game through visible UI, but asserts
// sync health (counters, §6) through here.
export interface NightSnapshot {
  gameId: string | null;
  over: boolean;
  syncMode: 'live' | 'awaitingKeyframe';
  lastAppliedSeq: number;
  counters: { patches: number; keyframes: number; resyncs: number; verifies: number; divergences: number };
  promptId: number | null;
  promptKind: string | null;
  /** payMana only: the remaining cost — re-asks mint fresh promptIds, so this
   *  is the auto-player's real progress signal for payment loops. */
  payRemaining: string | null;
  combatRole: 'attackers' | 'blockers' | null;
  inflight: boolean;
  turn: number | null;
}

declare global {
  interface Window { __night?: { snapshot(): NightSnapshot } }
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__night = {
    snapshot: () => {
      const g = appStores.game.getState();
      const p = appStores.prompt.getState();
      return {
        gameId: g.state?.gameId ?? null,
        over: g.over !== undefined,
        syncMode: g.syncMode,
        lastAppliedSeq: g.lastAppliedSeq,
        counters: { ...g.counters },
        promptId: p.pending?.promptId ?? null,
        promptKind: p.pending?.kind ?? null,
        payRemaining: p.pending?.kind === 'payMana' ? p.pending.remaining : null,
        combatRole: p.pending?.kind === 'priority' ? p.pending.combat?.role ?? null : null,
        inflight: p.inflight,
        turn: g.state?.turn.n ?? null,
      };
    },
  };
}
