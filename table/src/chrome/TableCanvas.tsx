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

    void scene.mount(host).then(() => {
      if (disposed) { scene.destroy(); return; }
      const paint = (): void => {
        const state = appStores.game.getState().state;
        if (state !== undefined) scene.renderState(state);
      };
      paint();
      unsub = appStores.game.subscribe(paint);
      observer = new ResizeObserver(() => scene.resize());
      observer.observe(host);
    });

    return () => {
      disposed = true;
      unsub?.();
      observer?.disconnect();
      scene.destroy();
    };
  }, []);

  return <div className="table-canvas" ref={hostRef} />;
}
