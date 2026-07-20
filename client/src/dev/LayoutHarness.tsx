// C5 layout harness (temporary — removed in Task 11). Mounts the real Game
// screen against a captured keyframe so the CSS pass can iterate in
// milliseconds instead of playing a game per tweak.
//
// #/layout      → the captured turn-25 board
// #/layout-fat  → the hand-fattened density ceiling
//
// Fixtures are statically imported from client/e2e/artifacts/ (the capture
// spec's canonical output) rather than fetched from client/public/: Vite
// copies publicDir into the production build verbatim regardless of DEV/PROD,
// so anything served from `public/` ships to `dist/` even when the code that
// reads it is dev-gated. A static import inside this module is stripped from
// the bundle along with the module itself (Rollup dead-code-eliminates the
// `#/layout` route behind `import.meta.env.DEV` in ui/App.tsx), so the data
// never reaches `dist/` at all.

import { useEffect } from 'react';
import { appStores } from '../app';
import type { GameState } from '../protocol/protocol';
import { Game } from '../ui/screens/Game';
// Fixture is captured external data, not authored/validated app state — cast
// through unknown at this one boundary, same as app.ts's `dumpState(): unknown`.
import realKeyframe from '../../e2e/artifacts/layout-keyframe.json';
import fatKeyframe from '../../e2e/artifacts/layout-keyframe-fat.json';

export function LayoutHarness({ variant }: { variant: 'real' | 'fat' }) {
  useEffect(() => {
    const state = (variant === 'fat' ? fatKeyframe : realKeyframe) as unknown as GameState;
    appStores.game.setState({ state });
  }, [variant]);

  // Match App.tsx's game-screen wrapper exactly (`<main className="app app-game">`)
  // so the harness renders inside the same container production uses — including
  // the 2400px ultrawide cap and viewport-height sizing `.app-game` provides.
  return (
    <main className="app app-game">
      <Game />
    </main>
  );
}
