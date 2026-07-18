// connection store (design §4) — socket FSM state. Written by net/socket only.

import { createStore } from 'zustand/vanilla';

export type SocketStatus = 'idle' | 'connecting' | 'helloSent' | 'ready' | 'dropped' | 'bumped' | 'fatal';

export interface ConnectionState {
  status: SocketStatus;
  attempt: number;             // consecutive reconnect attempts; 0 once ready
  lastError?: string;          // close/fatal reason for the UI
}

export const createConnectionStore = () =>
  createStore<ConnectionState>(() => ({ status: 'idle', attempt: 0 }));
