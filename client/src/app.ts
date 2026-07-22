// Composition root: the app's store/manager/action singletons. React imports
// from here; tests and headless runs build their own stacks via the factories.

import { recorder } from '@night/core/dev/recorder';
import { createCoreHarness, installHarness, sceneFromState } from '@night/core/harness';
import { createScryfallResolver } from '@night/core/images/scryfall';
import { createActions } from '@night/core/net/actions';
import { createSocketManager } from '@night/core/net/socket';
import { createStores } from '@night/core/stores';
import { browserKV } from '@night/core/stores/storage';

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

// Semantic test-harness handle for the Playwright auto-player (design §12). The
// shared `window.__night` contract (snapshot + click/answer/pass + scene) lives
// in @night/core/harness so both clients implement it identically; the classic
// client's scene() is state-derived (no canvas). Ships in dev, and in an
// explicitly-flagged build so the C5 smoke tier can drive the real production
// bundle. `npm run build` — the deploy path — never sets VITE_NIGHT_HARNESS, so
// prod has no handle.
const HARNESS = import.meta.env.DEV || import.meta.env.VITE_NIGHT_HARNESS === '1';

if (HARNESS && typeof window !== 'undefined') {
  installHarness(
    window,
    createCoreHarness(appStores, appActions),
    () => sceneFromState(appStores.game.getState().state),
  );
}
