// The Pixi host: a React component that owns one <canvas> filling the viewport
// (design §10 — Pixi owns the world, React the chrome above it). It creates the
// TableScene, renders the current GameState, and re-renders on every store
// change and on resize. The scene is imperative Pixi; React only mounts and
// tears it down.

import { useEffect, useRef } from 'react';
import { appStores } from '../app';
import { TableScene } from '../scene/TableScene';

export function TableCanvas(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const scene = new TableScene();
    let disposed = false;
    let unsub: (() => void) | undefined;
    let observer: ResizeObserver | undefined;

    // Camera rig (design §7.3): 1–4 pin a seat, ` frames the whole table, Esc
    // releases back to following the active player. Suspended while typing (T3
    // adds chat) — no text inputs exist yet, so guard on the target tag now.
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      if (e.key >= '1' && e.key <= '4') scene.focusSeat(Number(e.key) - 1);
      else if (e.key === '`' || e.key === '0') scene.showTable();
      else if (e.key === 'Escape') scene.releaseCamera();
    };

    void scene.mount(host).then(() => {
      if (disposed) { scene.destroy(); return; }
      // The director (§6.3) diffs consecutive states itself, so hand it the
      // authoritative state + the advisory events that rode on the transition
      // into it (game store `lastEvents`); it decides animate-vs-snap. Gate on
      // the applied seq: the game store also fires on non-transition updates
      // (game.over, the upstream-notice banner) that carry the same state and
      // now-stale events — presenting those would replay the last animation.
      let lastSeq = Number.NEGATIVE_INFINITY;
      const paint = (): void => {
        const g = appStores.game.getState();
        if (g.state === undefined || g.lastAppliedSeq === lastSeq) return;
        lastSeq = g.lastAppliedSeq;
        scene.present(g.state, g.lastEvents);
      };
      paint();
      unsub = appStores.game.subscribe(paint);
      observer = new ResizeObserver(() => scene.resize());
      observer.observe(host);
      window.addEventListener('keydown', onKey);
    });

    return () => {
      disposed = true;
      unsub?.();
      observer?.disconnect();
      window.removeEventListener('keydown', onKey);
      scene.destroy();
    };
  }, []);

  return <div className="table-canvas" ref={hostRef} />;
}
