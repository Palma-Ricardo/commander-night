// lobby store (design §4) — latest lobby.state snapshot. Written by lobby.state
// events (full small snapshot on every change, protocol §5).

import { createStore } from 'zustand/vanilla';
import type { LobbyState } from '../protocol/protocol';

export interface LobbyStoreState { state?: LobbyState }

export const createLobbyStore = () => createStore<LobbyStoreState>(() => ({}));
