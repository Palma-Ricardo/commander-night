// Composition root for the table client — the same @night/core stack the classic
// client builds (design §11): one set of stores, socket manager, actions, image
// resolver. The only differences are the renderer (Pixi, not React DOM) and that
// the harness scene() reads the live table's actors.

import { recorder } from '@night/core/dev/recorder';
import { createCoreHarness, installHarness, sceneFromState } from '@night/core/harness';
import { createScryfallResolver } from '@night/core/images/scryfall';
import { createActions } from '@night/core/net/actions';
import { createSocketManager } from '@night/core/net/socket';
import { applyKeyframe } from '@night/core/state/apply';
import { createStores } from '@night/core/stores';
import { browserKV } from '@night/core/stores/storage';
import { demoKeyframe } from './fixtures/keyframe';
import { runJuiceDemo } from './fixtures/juice-demo';
import { getActiveScene } from './scene/TableScene';

function bridgeUrl(): string {
  const configured = import.meta.env.VITE_BRIDGE_WS as string | undefined;
  if (configured) return configured;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

/** Dev, or a build explicitly flagged for the harness (`--mode harness`, which the
 *  deploy path never sets). Gates the `window.__night` handle and the §6
 *  keyframe-verify probe — the built-bundle tier exists to probe the real bundle's
 *  patch/keyframe conformance, and tying the probe to `DEV` alone left it off in
 *  exactly that tier (T5, 2026-07-24). */
const HARNESS = import.meta.env.DEV || import.meta.env.VITE_NIGHT_HARNESS === '1';

export const appKV = browserKV();
export const appStores = createStores(appKV);
export const appManager = createSocketManager({
  stores: appStores,
  kv: appKV,
  recorder,
  url: bridgeUrl(),
  strictDecode: import.meta.env.DEV,
  devVerify: HARNESS,
});
export const appScryfall = createScryfallResolver({ kv: appKV });
export const appActions = createActions(appStores, appManager, appKV, { scryfall: appScryfall });

/** T0: seed the demo keyframe so there is a table to render with no bridge
 *  running (design §13 exit). A live keyframe from the bridge overwrites it. */
export function seedDemo(): void {
  applyKeyframe(demoKeyframe, { stores: appStores, requestResync: () => {}, devVerify: false });
}

export function bootApp(): void {
  // T3: the client is interactive — dial the bridge and start at Home, exactly
  // like the classic client. `?demo` still seeds the offline demo table (visual
  // dev + the headless boot smoke); a live keyframe overwrites it, and if no
  // bridge answers the demo simply stays on screen.
  if (typeof location !== 'undefined' && location.search.includes('demo')) {
    seedDemo();
    // `?demo=juice`: play the scripted §9 animation reel over the seeded table
    // (dev-only review loop — see fixtures/juice-demo.ts). A short delay lets the
    // first paint settle before the first beat animates.
    if (location.search.includes('juice')) setTimeout(() => runJuiceDemo(appStores), 900);
  }
  appManager.connect();
}

// Semantic harness (§12), identical contract to the classic client. scene()
// reads the live Pixi actors; before the first frame it falls back to the
// state-derived scene so the handle is never empty.
if (HARNESS && typeof window !== 'undefined') {
  installHarness(
    window,
    createCoreHarness(appStores, appActions),
    {
      scene: () => getActiveScene()?.scene() ?? sceneFromState(appStores.game.getState().state),
      // §13's no-dead-end invariant over a canvas board: the ringed actors, read
      // from the live scene. Before the first layout there are no rings yet.
      highlights: () => getActiveScene()?.highlights() ?? [],
    },
  );
}
