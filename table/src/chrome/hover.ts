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
// T4 adds a grace on dismissal: leaving the hovered card (`hoverCardSoon`) defers
// the clear a beat so the pointer can travel onto the preview and hold it open —
// what lets you scroll a long oracle box (§9). A fresh hover, or the preview
// itself grabbing the pointer (`cancelHoverClear`), keeps it up.

import { createStore } from 'zustand/vanilla';
import type { Card } from '@night/core/protocol/protocol';

export interface HoverAnchor { left: number; top: number; width: number; height: number }

export interface HoverState { card?: Card; anchor?: HoverAnchor }

export const hoverStore = createStore<HoverState>(() => ({}));

let clearTimer: ReturnType<typeof setTimeout> | undefined;
const cancelPending = (): void => {
  if (clearTimer !== undefined) { clearTimeout(clearTimer); clearTimer = undefined; }
};

/** Show (or replace) the hovered card. Cancels any pending dismissal. */
export const hoverCard = (card: Card | undefined, anchor?: HoverAnchor): void => {
  cancelPending();
  hoverStore.setState({ card, anchor });
};

/** Dismiss after a short grace, so the pointer can cross the gap onto the preview
 *  and keep it open (`cancelHoverClear`). A fresh `hoverCard` cancels it too, so
 *  moving between two cards never flickers. */
export const hoverCardSoon = (): void => {
  cancelPending();
  clearTimer = setTimeout(() => { clearTimer = undefined; hoverStore.setState({}); }, 140);
};

/** The pointer entered the preview — hold it (cancel the deferred dismissal). */
export const cancelHoverClear = (): void => cancelPending();
