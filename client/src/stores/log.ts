// log store (design §4) — seq-keyed ordered entries, ring 500. Written by
// game.log routing (dedupe by seq absorbs resume backfill, protocol §14).

import { createStore } from 'zustand/vanilla';
import type { LogEntry } from '../protocol/protocol';

export interface LogStoreState {
  entries: LogEntry[];         // seq-ascending
  /** Chat lines from other seats appended while the chat tab wasn't watching;
   *  cleared through the markChatRead action (§8 unread badge). */
  unreadChat: number;
}

export const createLogStore = () => createStore<LogStoreState>(() => ({ entries: [], unreadChat: 0 }));
