// Store set (design §4): every piece of mutable state has exactly one owning
// store, and only the protocol layer (net/) writes it. React components read via
// selectors and call actions; they never mutate stores.
//
// createStores() is a factory so tests, replay, and multi-client live checks can
// run isolated client stacks; the app's singletons live in src/app.ts.

import { createConnectionStore } from './connection';
import { createGameStore } from './game';
import { createLobbyStore } from './lobby';
import { createLogStore } from './log';
import { createNoticesStore } from './notices';
import { createPromptStore } from './prompt';
import { createSessionStore } from './session';
import { createSettingsStore } from './settings';
import type { KV } from './storage';

export type { ConnectionState, SocketStatus } from './connection';
export type { GameStoreState, SyncCounters } from './game';
export type { LobbyStoreState } from './lobby';
export type { LogStoreState } from './log';
export type { Notice, NoticesState } from './notices';
export type { PromptStoreState } from './prompt';
export type { ResumeAnchor, SessionState } from './session';
export type { SettingsState } from './settings';

export interface Stores {
  connection: ReturnType<typeof createConnectionStore>;
  session: ReturnType<typeof createSessionStore>;
  lobby: ReturnType<typeof createLobbyStore>;
  game: ReturnType<typeof createGameStore>;
  prompt: ReturnType<typeof createPromptStore>;
  log: ReturnType<typeof createLogStore>;
  notices: ReturnType<typeof createNoticesStore>;
  settings: ReturnType<typeof createSettingsStore>;
}

export function createStores(kv: KV): Stores {
  return {
    connection: createConnectionStore(),
    session: createSessionStore(kv),
    lobby: createLobbyStore(),
    game: createGameStore(),
    prompt: createPromptStore(),
    log: createLogStore(),
    notices: createNoticesStore(),
    settings: createSettingsStore(kv),
  };
}
