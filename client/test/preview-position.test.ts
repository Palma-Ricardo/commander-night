// Hover-preview placement (C5). Pure geometry, so the flip-to-left branch is
// asserted directly here — it is not reachable by screenshotting a board (the
// preview scales with --card-unit, so crowding the right edge shrinks the
// preview too and the flip never fires). The real-world case is a .log-ref
// hover in the right-hand log column; that geometry is reproduced below.

import { describe, expect, it } from 'vitest';
import { GAP, MARGIN, previewPosition, type Size } from '../src/ui/cards/preview-position';
import type { HoverAnchor } from '../src/ui/hover';

const anchorAt = (left: number, top = 400, width = 90, height = 126): HoverAnchor =>
  ({ left, top, width, height });

const PREVIEW: Size = { width: 280, height: 390 };
const VIEW_1080: Size = { width: 1920, height: 1000 };

/** Does the placed preview overlap the anchor's box at all? */
function overlaps(pos: { left: number; top: number }, size: Size, a: HoverAnchor): boolean {
  return pos.left < a.left + a.width && pos.left + size.width > a.left
    && pos.top < a.top + a.height && pos.top + size.height > a.top;
}

describe('previewPosition', () => {
  it('sits to the right of the anchor when there is room', () => {
    const a = anchorAt(300);
    const pos = previewPosition(a, PREVIEW, VIEW_1080);
    expect(pos.side).toBe('right');
    expect(pos.left).toBe(a.left + a.width + GAP);
    expect(overlaps(pos, PREVIEW, a)).toBe(false);
  });

  it('flips to the left when the right edge would overflow the viewport', () => {
    // A card hugging the right edge — the .log-ref-in-the-log-column case.
    const a = anchorAt(VIEW_1080.width - 140);
    const pos = previewPosition(a, PREVIEW, VIEW_1080);
    expect(pos.side).toBe('left');
    expect(pos.left).toBe(a.left - GAP - PREVIEW.width);
    // The whole point of the flip: the card stays visible and the preview
    // stays on-screen.
    expect(overlaps(pos, PREVIEW, a)).toBe(false);
    expect(pos.left).toBeGreaterThanOrEqual(MARGIN);
    expect(pos.left + PREVIEW.width).toBeLessThanOrEqual(VIEW_1080.width - MARGIN);
  });

  it('flips left rather than overflowing by even a pixel', () => {
    // Right placement would end exactly 1px past the margin.
    const w = PREVIEW.width;
    const a = anchorAt(VIEW_1080.width - MARGIN - w - GAP - 90 + 1, 400, 90);
    const pos = previewPosition(a, PREVIEW, VIEW_1080);
    expect(pos.side).toBe('left');
  });

  it('takes the right branch at exactly the fitting boundary', () => {
    const w = PREVIEW.width;
    const a = anchorAt(VIEW_1080.width - MARGIN - w - GAP - 90, 400, 90);
    const pos = previewPosition(a, PREVIEW, VIEW_1080);
    expect(pos.side).toBe('right');
    expect(pos.left + w).toBe(VIEW_1080.width - MARGIN);
  });

  it('clamps on-screen when neither side can clear the anchor', () => {
    // Narrow viewport, wide preview: no side fits.
    const view: Size = { width: 500, height: 800 };
    const a = anchorAt(180, 300, 90, 126);
    const pos = previewPosition(a, PREVIEW, view);
    expect(pos.side).toBe('clamped');
    expect(pos.left).toBeGreaterThanOrEqual(MARGIN);
    expect(pos.left + PREVIEW.width).toBeLessThanOrEqual(view.width - MARGIN);
  });

  it('picks the lesser-overlap side when clamping', () => {
    const view: Size = { width: 500, height: 800 };
    // Neither side fits (left would start at -6, right would end at 676 in a
    // 500px viewport), and the anchor sits right-of-centre — so clamping
    // right would cover it completely while clamping left barely grazes it.
    const a = anchorAt(290, 300, 90, 126);
    const pos = previewPosition(a, PREVIEW, view);
    expect(pos.side).toBe('clamped');
    expect(pos.left).toBe(MARGIN);
    expect(pos.left).toBeLessThan(a.left);
  });

  it('centres vertically on the anchor', () => {
    const a = anchorAt(300, 400, 90, 126);
    const pos = previewPosition(a, PREVIEW, VIEW_1080);
    expect(pos.top).toBe(a.top + a.height / 2 - PREVIEW.height / 2);
  });

  it('clamps vertically at the top and bottom edges', () => {
    const high = previewPosition(anchorAt(300, 0, 90, 126), PREVIEW, VIEW_1080);
    expect(high.top).toBe(MARGIN);

    const low = previewPosition(anchorAt(300, 980, 90, 126), PREVIEW, VIEW_1080);
    expect(low.top).toBe(VIEW_1080.height - PREVIEW.height - MARGIN);
  });

  it('keeps the preview on-screen when it is taller than the viewport', () => {
    const tall: Size = { width: 280, height: 2000 };
    const pos = previewPosition(anchorAt(300, 400), tall, VIEW_1080);
    expect(pos.top).toBe(MARGIN);
  });
});
