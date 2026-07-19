// C5 layout harness (temporary — removed in Task 11). Mounts the real Game
// screen against a captured keyframe so the CSS pass can iterate in
// milliseconds instead of playing a game per tweak.
//
// #/layout      → the captured turn-12 board
// #/layout-fat  → the hand-fattened density ceiling
//
// Fixtures are fetched from client/public/ rather than through a Vite `/@fs`
// path: `import.meta.url` inside a dev-served module resolves to an
// `http://…` URL (not `file://`), so `new URL('.', import.meta.url).pathname`
// yields a web path like `/src/dev/`, not a real filesystem path — `/@fs`
// needs the latter. Serving the two JSONs as static assets sidesteps that.

import { useEffect, useState } from 'react';
import { appStores } from '../app';
import type { GameState } from '../protocol/protocol';
import { Game } from '../ui/screens/Game';

export function LayoutHarness({ variant }: { variant: 'real' | 'fat' }) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const file = variant === 'fat' ? 'layout-keyframe-fat.json' : 'layout-keyframe.json';
    let cancelled = false;
    void fetch(`/${file}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((state: GameState) => { if (!cancelled) appStores.game.setState({ state }); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [variant]);

  if (error !== null) {
    return <main className="app"><p>layout fixture failed to load: {error}</p></main>;
  }
  return <Game />;
}
