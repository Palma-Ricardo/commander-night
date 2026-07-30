// The enlarged hover preview (§9): image when resolved, text frame as the
// preview body when not. One global instance fed by the hover store. In the table
// client the hover store is filled from two sources — DOM cards in modals
// (CardView) and canvas actors (TableCanvas maps a Pixi pointerover to an anchor
// via the live camera), so a card previews the same whether it is on the felt or
// in a grid. Ported from client/src/ui/cards/HoverPreview.tsx.
//
// Anchored beside the hovered card rather than pinned to a fixed corner. Offsets
// off the hovered element's *edges* (left/top/width/height), not its centre
// point: cards are far wider than the gap, so a centre-relative offset put the
// preview's near edge inside the card it was supposed to sit beside. Flips side
// and clamps to stay on-screen; falls back to the lower-left position when no
// anchor is supplied (see the CSS default in styles.css).

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { appScryfall } from '../app';
import { hoverCard, hoverStore, setPreviewRect } from './hover';
import { previewPosition } from './preview-position';
import { TextFrame } from './CardView';

export function HoverPreview() {
  const card = useStore(hoverStore, s => s.card);
  const anchor = useStore(hoverStore, s => s.anchor);
  const zoom = useStore(hoverStore, s => s.zoom ?? 1);
  const image = useStore(appScryfall.store, s => (card !== undefined ? s.images[appScryfall.keyOf(card)] : undefined));
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (anchor === undefined || ref.current === null) { setStyle({}); return; }
    const el = ref.current;

    // The placement rules themselves live in preview-position.ts as pure
    // geometry, so they can be asserted without a browser.
    const rect = el.getBoundingClientRect();
    const { left, top } = previewPosition(
      anchor,
      rect,
      { width: window.innerWidth, height: window.innerHeight },
    );
    setStyle({ left: `${left}px`, top: `${top}px`, bottom: 'auto' });
    // NB: the zoom rides a CSS custom property on the element (below), not this
    // style object — re-running layout is what re-anchors the grown box, and it is
    // in this effect's deps so a wheel step repositions as well as resizes.
    // Publish the laid-out rect so the scene can hold the preview open while the
    // pointer is over it (its own dismissal authority, hover.ts). getBoundingClientRect
    // still reads the pre-position box, so report the placement we just computed.
    setPreviewRect({ left, top, width: rect.width, height: rect.height });

    // On resize, dismiss rather than reposition — the anchor is a plain snapshot
    // taken at hover-time and any reflow invalidates it. A dismiss can't be wrong;
    // the next mouse move re-hovers.
    const dismiss = () => hoverCard(undefined);
    window.addEventListener('resize', dismiss);
    return () => window.removeEventListener('resize', dismiss);
  }, [anchor, card, image?.status, zoom]);

  // Clear the published rect when the preview goes away, so a stale rect can never
  // keep the scene thinking the pointer is "over the preview".
  useEffect(() => () => setPreviewRect(undefined), []);

  if (card === undefined) return null;

  return (
    // Fully click-through (pointer-events: none, styles.css): the canvas keeps
    // receiving pointermove under it so the scene's hover authority stays accurate,
    // and a board click is never swallowed by the panel.
    <div
      className="hover-preview"
      ref={ref}
      style={{ ...style, '--preview-zoom': zoom } as CSSProperties}
      data-zoomed={zoom > 1 ? '1' : undefined}
    >
      {image?.status === 'ok'
        ? <img src={image.url} alt={card.name} />
        : <TextFrame card={card} size="preview" />}
      {image?.status === 'ok' && card.text.length > 0 && (
        <div className="hover-oracle">
          {card.text.map((l, i) => <p key={i}>{l}</p>)}
        </div>
      )}
    </div>
  );
}
