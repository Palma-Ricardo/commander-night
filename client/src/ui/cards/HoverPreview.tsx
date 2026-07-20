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
import { hoverStore } from '../hover';
import { TextFrame } from './CardView';

const GAP = 16;     // px between the hovered card and the preview
const MARGIN = 12;  // px kept clear of every viewport edge

export function HoverPreview() {
  const card = useStore(hoverStore, s => s.card);
  const anchor = useStore(hoverStore, s => s.anchor);
  const image = useStore(appScryfall.store, s => (card !== undefined ? s.images[appScryfall.keyOf(card)] : undefined));
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (anchor === undefined || ref.current === null) { setStyle({}); return; }
    const el = ref.current;

    // Offsets off the card's *edges*, not its centre — every card on screen
    // is far wider than GAP, so a centre-relative offset used to land the
    // preview's near edge inside the card's own box.
    const reposition = () => {
      const { width: w, height: h } = el.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      const rightPos = anchor.left + anchor.width + GAP;
      const leftPos = anchor.left - GAP - w;
      const fitsRight = rightPos + w <= viewportWidth - MARGIN;
      const fitsLeft = leftPos >= MARGIN;

      let left: number;
      if (fitsRight) {
        left = rightPos;
      } else if (fitsLeft) {
        left = leftPos;
      } else {
        // Neither side clears the card fully (very wide preview, narrow
        // viewport) — clamp to the viewport and accept overlap, but pick
        // whichever side overlaps the card's box the least.
        const maxLeft = Math.max(MARGIN, viewportWidth - w - MARGIN);
        const rightClamped = Math.min(rightPos, maxLeft);
        const leftClamped = Math.max(leftPos, MARGIN);
        const overlap = (pos: number) =>
          Math.max(0, Math.min(pos + w, anchor.left + anchor.width) - Math.max(pos, anchor.left));
        left = overlap(rightClamped) <= overlap(leftClamped) ? rightClamped : leftClamped;
      }

      const maxTop = Math.max(MARGIN, viewportHeight - h - MARGIN);
      const top = anchor.top + anchor.height / 2 - h / 2;
      setStyle({
        left: `${left}px`,
        top: `${Math.min(Math.max(top, MARGIN), maxTop)}px`,
        bottom: 'auto',
      });
    };

    reposition();
    // A window resize mid-hover would otherwise leave the preview positioned
    // against stale bounds until the next hover fires the effect again.
    window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
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
