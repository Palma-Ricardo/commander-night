// Hover-preview state — ephemeral view state (not protocol state, so outside
// the design-§4 store table): the card currently hovered anywhere a card
// appears (§9). One global preview panel reads it.
//
// C5 adds the anchor: the hovered element's viewport geometry, so the preview
// can appear beside what you are pointing at instead of in a fixed corner
// half a screen away on a 1440p display. A bare centre point isn't enough —
// every card on screen is far wider than the gap the preview offsets by, so
// positioning off the centre lands the preview on top of the card itself.
// Offsetting off the edges (left + width) is what actually clears the card.
// A plain box `{ left, top, width, height }` (not a live DOMRect) keeps this
// serializable and decoupled from whatever element produced it.
//
// T4 makes this a *dumb state holder*: it no longer runs any dismissal timer or
// grace of its own. The scene owns the lifecycle — it tracks the real pointer and
// dismisses the preview when the pointer is over neither the hovered card nor the
// preview itself. So the preview publishes its measured on-screen rect back here
// (`previewRect`) for the scene to read; nothing in the DOM captures the pointer,
// which is what let the old grace-timer/interactive-oracle design get stuck.

import { createStore } from 'zustand/vanilla';
import type { Card } from '@night/core/protocol/protocol';

export interface HoverAnchor { left: number; top: number; width: number; height: number }

/** Who put the current card up: the canvas scene (which owns its own dismissal via
 *  the live pointer) or a DOM source (a modal card grid, a log reference, which
 *  dismiss on their own mouseleave). A source only ever hides *its own* preview, so
 *  the scene's grace can never yank a DOM preview out from under the pointer. */
export type HoverOwner = 'scene' | 'dom';

export interface HoverState {
  card?: Card;
  anchor?: HoverAnchor;
  owner?: HoverOwner;
  /** The preview panel's measured viewport rect, published by HoverPreview after
   *  layout so the scene can hold the preview open while the pointer is over it. */
  previewRect?: HoverAnchor;
  /** Wheel zoom on the preview (Issues.txt #13), 1 = the CSS base width. Per-card:
   *  reset by `hoverCard`, so scrolling one card big never leaves the next one
   *  blown up. Absent = 1. */
  zoom?: number;
}

export const hoverStore = createStore<HoverState>(() => ({}));

/** Zoom bounds. The floor is the base size (the preview is already sized to be
 *  readable); the ceiling keeps a 63×88 card inside a 1080p window. */
export const PREVIEW_ZOOM_MIN = 1;
export const PREVIEW_ZOOM_MAX = 2.2;
const ZOOM_STEP = 0.12;

/** Show (or replace) the hovered card. Clears any stale preview rect — the panel
 *  re-publishes it once it lays out at the new anchor — and resets the zoom. */
export const hoverCard = (card: Card | undefined, anchor?: HoverAnchor, owner: HoverOwner = 'dom'): void => {
  hoverStore.setState({ card, anchor, owner, previewRect: undefined, zoom: PREVIEW_ZOOM_MIN });
};

/** Wheel the preview bigger (`dir` < 0, scroll up) or smaller. No-op with no
 *  preview open. Returns true if it consumed the gesture, so the caller knows
 *  whether to fall through to its own wheel handling. */
export const zoomPreview = (dir: number): boolean => {
  const s = hoverStore.getState();
  if (s.card === undefined) return false;
  const next = clampZoom((s.zoom ?? PREVIEW_ZOOM_MIN) - Math.sign(dir) * ZOOM_STEP);
  if (next !== s.zoom) hoverStore.setState({ ...s, zoom: next });
  return true;
};

const clampZoom = (z: number): number =>
  Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, Math.round(z * 1000) / 1000));

/** Hide the preview, but only if `owner` is the one showing it — so a stale grace
 *  from one source can't dismiss another source's preview. Replaces the state (not
 *  a merge: `setState({})` shallow-merges and would leave `card` in place — the very
 *  no-op that let the preview stick). */
export const hideHover = (owner: HoverOwner): void => {
  const s = hoverStore.getState();
  if (s.card !== undefined && s.owner === owner) hoverStore.setState({}, true);
};

/** The preview panel reports its laid-out rect so the scene can keep it open while
 *  the pointer is over it (e.g. to read a long card). */
export const setPreviewRect = (rect: HoverAnchor | undefined): void => {
  if (hoverStore.getState().previewRect !== rect) {
    hoverStore.setState(s => ({ ...s, previewRect: rect }));
  }
};
