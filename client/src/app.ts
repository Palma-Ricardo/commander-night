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
});
export const appActions = createActions(appStores, appManager, appKV);
export const appScryfall = createScryfallResolver({ kv: appKV });

export function bootApp(): void {
  appManager.connect();
}
