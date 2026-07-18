// Hover-preview state — ephemeral view state (not protocol state, so outside
// the design-§4 store table): the card currently hovered anywhere a card
// appears (§9). One global preview panel reads it.

import { createStore } from 'zustand/vanilla';
import type { Card } from '../protocol/protocol';

export interface HoverState { card?: Card }

export const hoverStore = createStore<HoverState>(() => ({}));

export const hoverCard = (card: Card | undefined) => hoverStore.setState({ card });
