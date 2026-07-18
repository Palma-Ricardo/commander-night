// log store (design §4) — seq-keyed ordered entries, ring 500. Written by
// game.log routing (dedupe by seq absorbs resume backfill, protocol §14).
// Unread-chat count lands with the chat panel in C4.

import { createStore } from 'zustand/vanilla';
import type { LogEntry } from '../protocol/protocol';

export interface LogStoreState { entries: LogEntry[] }   // seq-ascending

export const createLogStore = () => createStore<LogStoreState>(() => ({ entries: [] }));
