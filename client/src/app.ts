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

/** Dev, or a build explicitly flagged for the harness (`--mode harness`, which the
 *  deploy path never sets). Gates the `window.__night` handle and the §6
 *  keyframe-verify probe: the built-bundle tier exists to probe the *real* bundle's
 *  patch/keyframe conformance, so tying the probe to `DEV` alone left it off in
 *  exactly the tier that wanted it (the auto-player asserts `verifies ≥ 1`, which a
 *  built bundle could never satisfy — found at T5, 2026-07-24). */
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

export function bootApp(): void {
  appManager.connect();
}

// Semantic test-harness handle for the Playwright auto-player (design §12). The
// shared `window.__night` contract (snapshot + prompt/click/answer/pass + scene +
// highlights) lives in @night/core/harness so both clients implement it
// identically; the classic client's scene() is state-derived (no canvas) and its
// highlights() reads the rendered DOM rings. Gated on HARNESS above, so
// `npm run build` — the deploy path — ships no handle.

/** The classic client's `highlights()` (T5): read straight off the rendered
 *  board, so the specs keep proving that the DOM really exposed the affordance
 *  rather than that the model computed one. Cards carry `data-card-id`; the seat
 *  panel and stack items carry `data-object-id`. Modal grid cards land here too —
 *  they take `.hl-target` from their click override — which is harmless: the driver
 *  counts dock/modal controls separately anyway, and on the table client (where the
 *  felt is a canvas) the modal is the only half that can be read from the DOM. */
const HL_SELECTOR = '.hl-action, .hl-target, .hl-combat, .hl-declared, .hl-source';

function domHighlights(): string[] {
  if (typeof document === 'undefined') return [];
  const ids: string[] = [];
  for (const el of document.querySelectorAll(HL_SELECTOR)) {
    const id = el.getAttribute('data-card-id') ?? el.getAttribute('data-object-id');
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

if (HARNESS && typeof window !== 'undefined') {
  installHarness(
    window,
    createCoreHarness(appStores, appActions),
    {
      scene: () => sceneFromState(appStores.game.getState().state),
      highlights: domHighlights,
    },
  );
}
