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

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { appScryfall } from '../app';
import { cancelHoverClear, hoverCard, hoverCardSoon, hoverStore } from './hover';
import { previewPosition } from './preview-position';
import { TextFrame } from './CardView';

export function HoverPreview() {
  const card = useStore(hoverStore, s => s.card);
  const anchor = useStore(hoverStore, s => s.anchor);
  const image = useStore(appScryfall.store, s => (card !== undefined ? s.images[appScryfall.keyOf(card)] : undefined));
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (anchor === undefined || ref.current === null) { setStyle({}); return; }
    const el = ref.current;

    // The placement rules themselves live in preview-position.ts as pure
    // geometry, so they can be asserted without a browser.
    const { left, top } = previewPosition(
      anchor,
      el.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight },
    );
    setStyle({ left: `${left}px`, top: `${top}px`, bottom: 'auto' });

    // On resize, dismiss rather than reposition — the anchor is a plain
    // snapshot taken at hover-time and any reflow invalidates it. The same
    // applies when the camera moves under an open preview (canvas hovers): the
    // TableCanvas clears the hover on a camera change, so the anchor is never
    // stale for long. A dismiss can't be wrong; the next mouse move re-hovers.
    const dismiss = () => hoverCard(undefined);
    window.addEventListener('resize', dismiss);
    return () => window.removeEventListener('resize', dismiss);
  }, [anchor, card, image?.status]);

  if (card === undefined) return null;

  return (
    <div className="hover-preview" ref={ref} style={style}>
      {image?.status === 'ok'
        ? <img src={image.url} alt={card.name} />
        : <TextFrame card={card} size="preview" />}
      {image?.status === 'ok' && card.text.length > 0 && (
        // The one interactive part of the (otherwise click-through) preview: keep
        // it alive while the pointer is on it so a long oracle box can be scrolled.
        <div
          className="hover-oracle"
          onMouseEnter={cancelHoverClear}
          onMouseLeave={hoverCardSoon}
        >
          {card.text.map((l, i) => <p key={i}>{l}</p>)}
        </div>
      )}
    </div>
  );
}
