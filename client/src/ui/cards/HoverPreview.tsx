// The enlarged hover preview (§9): image when resolved, text frame as the
// preview body when not. One global instance fed by the hover store.
//
// C5: anchored beside the hovered card rather than pinned to a fixed corner —
// on a 1440p board the corner was half a screen away and could sit on top of
// the prompt dock. Offsets off the hovered element's *edges* (left/top/
// width/height), not its centre point: cards are far wider than the gap, so
// a centre-relative offset put the preview's near edge inside the card it
// was supposed to sit beside. Flips side and clamps vertically/horizontally
// to stay on-screen; falls back to the old lower-left position when no
// anchor is supplied (see the CSS default in styles.css).
//
// The preview's width is viewport-derived (--card-unit, styles.css) and its
// height depends on card art aspect ratio plus however much oracle text is
// showing, so no constant is trustworthy here. Instead we measure the
// rendered box with a ref and reposition in a layout effect, which runs
// before the browser paints — the element commits once with the previous
// hover's position (or the CSS fallback on first mount) and is repositioned
// synchronously before that frame is shown, so there is no visible jump.

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { appScryfall } from '../../app';
import { hoverCard, hoverStore } from '../hover';
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
    // geometry, so they can be asserted without a browser (test/
    // preview-position.test.ts) — the flip-to-left branch is not reachable by
    // screenshotting a real board.
    const { left, top } = previewPosition(
      anchor,
      el.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight },
    );
    setStyle({ left: `${left}px`, top: `${top}px`, bottom: 'auto' });

    // On resize, dismiss rather than reposition. `anchor` is a plain
    // snapshot taken at mouseenter — it is never re-measured, and card
    // geometry is viewport-derived (--card-unit, the log column width), so
    // any reflow (window resize, DevTools toggle, browser zoom, OS
    // display-scale change) invalidates it instantly, none of which require
    // the mouse to leave the card. Repositioning against that stale anchor
    // would silently reintroduce the overlap-on-the-hovered-card bug this
    // component exists to avoid. A resize mid-hover is transient and rare;
    // dismissing (the same path mouseleave takes) can't be wrong, and the
    // next mouse movement re-hovers with fresh geometry.
    const dismiss = () => hoverCard(undefined);
    window.addEventListener('resize', dismiss);
    return () => window.removeEventListener('resize', dismiss);
    // image?.status is a dependency too: swapping the text-frame body for the
    // resolved <img> (or vice versa) changes the box's height.
  }, [anchor, card, image?.status]);

  if (card === undefined) return null;

  return (
    <div className="hover-preview" ref={ref} style={style}>
      {image?.status === 'ok'
        ? <img src={image.url} alt={card.name} />
        : <TextFrame card={card} size="preview" />}
      {image?.status === 'ok' && card.text.length > 0 && (
        <div className="hover-oracle">{card.text.map((l, i) => <p key={i}>{l}</p>)}</div>
      )}
    </div>
  );
}
