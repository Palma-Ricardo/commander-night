// The Pixi host: a React component that owns one <canvas> filling the viewport
// (design §10 — Pixi owns the world, React the chrome above it). It creates the
// TableScene, drives it from the stores, and wires the scene's semantic
// interaction callbacks into the shared @night/core logic:
//
//  • game store  → director.present(state, events)   (T2, gated on applied seq)
//  • prompt store → scene.setPrompt(...)             (T3 board affordances + §6.4/§14)
//  • scene click  → interact.objectClick(prompt, id) (the same router the DOM uses)
//  • scene hover  → the hover store, anchored to the live actor (§9/§10)
//
// The scene is imperative Pixi; React only mounts and tears it down. Keyboard
// (camera + game shortcuts) is owned by chrome/shortcuts.ts, mounted by the game
// overlay — not here — so it exists only where a game does.

import { useEffect, useRef } from 'react';
import { appScryfall, appStores } from '../app';
import { findObject } from '@night/core/state/selectors';
import { TableScene } from '../scene/TableScene';
import { objectClick } from './interact';
import { hoverCard } from './hover';

export function TableCanvas(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const scene = new TableScene();
    let disposed = false;
    const unsubs: (() => void)[] = [];
    let observer: ResizeObserver | undefined;

    void scene.mount(host, appScryfall).then(() => {
      if (disposed) { scene.destroy(); return; }

      // Clicks route through the pending prompt's affordance, exactly as a DOM
      // card click does — the felt and a modal grid mean the same thing (§7).
      scene.onObjectClick = (id) => { objectClick(appStores.prompt.getState(), id); };

      // Hover previews any face-up card, anchored beside the live actor (§9/§10).
      scene.onObjectHover = (id, anchor) => {
        if (id === undefined) { hoverCard(undefined); return; }
        const card = findObject(appStores.game.getState().state!, id);
        if (card !== undefined) hoverCard(card, anchor);
      };

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
      unsubs.push(appStores.game.subscribe(paint));

      // Board affordances + the §6.4 flush / §14 pull-back key off the prompt.
      // Selection scratch (chooseTargets) also lives in this store, so a toggle
      // re-renders the highlight without a new promptId.
      const syncPrompt = (): void => scene.setPrompt(appStores.prompt.getState());
      syncPrompt();
      unsubs.push(appStores.prompt.subscribe(syncPrompt));

      observer = new ResizeObserver(() => scene.resize());
      observer.observe(host);
    });

    return () => {
      disposed = true;
      for (const u of unsubs) u();
      observer?.disconnect();
      scene.destroy();
    };
  }, []);

  return <div className="table-canvas" ref={hostRef} />;
}
