// Hover-preview state — ephemeral view state (not protocol state, so outside
// the design-§4 store table): the card currently hovered anywhere a card
// appears (§9). One global preview panel reads it.
//
// C5 adds the anchor: the hovered element's viewport centre, so the preview
// can appear beside what you are pointing at instead of in a fixed corner
// half a screen away on a 1440p display.

import { createStore } from 'zustand/vanilla';
import type { Card } from '../protocol/protocol';

export interface HoverAnchor { x: number; y: number }

export interface HoverState { card?: Card; anchor?: HoverAnchor }

export const hoverStore = createStore<HoverState>(() => ({}));

export const hoverCard = (card: Card | undefined, anchor?: HoverAnchor) =>
  hoverStore.setState({ card, anchor });
