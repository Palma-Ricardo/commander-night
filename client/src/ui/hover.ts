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

import { createStore } from 'zustand/vanilla';
import type { Card } from '../protocol/protocol';

export interface HoverAnchor { left: number; top: number; width: number; height: number }

export interface HoverState { card?: Card; anchor?: HoverAnchor }

export const hoverStore = createStore<HoverState>(() => ({}));

export const hoverCard = (card: Card | undefined, anchor?: HoverAnchor) =>
  hoverStore.setState({ card, anchor });
