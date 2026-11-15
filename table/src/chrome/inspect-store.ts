// The inspect sheet's state (mobile plan §3): which card is open, plus the card
// snapshot the scene had for it — a carousel entry (a library search, a
// look-at-the-top pick) may name an object the game state does not hold, so the
// sheet falls back to this when `findObject` comes up empty. Ephemeral view
// state, like the hover store.

import { createStore } from 'zustand/vanilla';
import type { Card, Id } from '@night/core/protocol/protocol';

export interface InspectState { id?: Id; card?: Card }

export const inspectStore = createStore<InspectState>(() => ({}));

export const inspectCard = (id: Id, card?: Card): void => { inspectStore.setState({ id, card }); };
export const closeInspect = (): void => { inspectStore.setState({ id: undefined, card: undefined }); };
