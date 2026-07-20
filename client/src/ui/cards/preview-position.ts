// Where the hover preview goes, as pure geometry (C5).
//
// Extracted from HoverPreview so the placement rules are testable without a
// browser. The flip-to-left branch in particular is not reachable by
// screenshotting a real board: the preview's width is itself --card-unit
// derived, so narrowing the viewport to crowd the right edge shrinks the
// preview by the same measure and the flip never triggers. The case that
// genuinely needs it is a .log-ref hover inside the log column, which sits
// flush against the right edge. Rather than hunt that with a camera, the
// rules live here and are asserted directly.
//
// Offsets come off the anchor's *edges*, never its centre: every card on
// screen is far wider than GAP, so a centre-relative offset lands the
// preview's near edge inside the card it is meant to sit beside.

import type { HoverAnchor } from '../hover';

export const GAP = 16;     // px between the hovered card and the preview
export const MARGIN = 12;  // px kept clear of every viewport edge

export interface Size { width: number; height: number }

export interface PreviewPosition {
  left: number;
  top: number;
  /** Which branch placed it — for tests and debugging, not for styling. */
  side: 'right' | 'left' | 'clamped';
}

/**
 * Place a preview of `size` beside `anchor` within `viewport`.
 *
 * Prefers the right of the anchor, flips left when the right would overflow,
 * and when neither side clears the anchor (very wide preview, narrow
 * viewport) clamps to the viewport picking whichever side covers the anchor
 * least. Vertically centres on the anchor, clamped to stay on-screen.
 */
export function previewPosition(
  anchor: HoverAnchor,
  size: Size,
  viewport: Size,
): PreviewPosition {
  const { width: w, height: h } = size;

  const rightPos = anchor.left + anchor.width + GAP;
  const leftPos = anchor.left - GAP - w;
  const fitsRight = rightPos + w <= viewport.width - MARGIN;
  const fitsLeft = leftPos >= MARGIN;

  let left: number;
  let side: PreviewPosition['side'];
  if (fitsRight) {
    left = rightPos;
    side = 'right';
  } else if (fitsLeft) {
    left = leftPos;
    side = 'left';
  } else {
    const maxLeft = Math.max(MARGIN, viewport.width - w - MARGIN);
    const rightClamped = Math.min(rightPos, maxLeft);
    const leftClamped = Math.max(leftPos, MARGIN);
    const overlap = (pos: number) =>
      Math.max(0, Math.min(pos + w, anchor.left + anchor.width) - Math.max(pos, anchor.left));
    left = overlap(rightClamped) <= overlap(leftClamped) ? rightClamped : leftClamped;
    side = 'clamped';
  }

  const maxTop = Math.max(MARGIN, viewport.height - h - MARGIN);
  const top = Math.min(Math.max(anchor.top + anchor.height / 2 - h / 2, MARGIN), maxTop);

  return { left, top, side };
}
