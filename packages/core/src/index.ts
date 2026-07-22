// @night/core — the view-independent client engine, extracted from the classic
// client at T0 (table-client design §11). Both the classic React client and the
// new Pixi table client compose their runtime from these pieces; only the
// *rendering* of the resolved state differs between them.
//
// Subpaths (`@night/core/protocol/protocol`, `@night/core/stores`, …) stay
// available for call sites that want a specific module; this barrel is the
// convenience surface for a composition root.

// Protocol wire types + codec + command builders
export * from './protocol/protocol';
export { decode, encode } from './protocol/codec';
export { defaultContext, hello, gameResync } from './protocol/commands';
export type { CommandContext } from './protocol/commands';

// Stores (design §4): factories + state types
export { createStores } from './stores';
export type {
  Stores,
  ConnectionState,
  SocketStatus,
  GameStoreState,
  SyncCounters,
  LobbyStoreState,
  LogStoreState,
  Notice,
  NoticesState,
  PromptStoreState,
  ResumeAnchor,
  SessionState,
  SettingsState,
} from './stores';
export { freshGame } from './stores/game';
export { browserKV, memoryKV, KEYS } from './stores/storage';
export type { KV } from './stores/storage';

// Net: socket FSM + action builders
export { createSocketManager } from './net/socket';
export type { SocketManager, SocketManagerOpts } from './net/socket';
export { createActions } from './net/actions';

// State application (keyframe / patch)
export { applyKeyframe, applyStatePatch } from './state/apply';

// Image resolution (shared Scryfall layer, §11)
export { createScryfallResolver } from './images/scryfall';
export type { ScryfallResolver, CardIdentity } from './images/scryfall';
export { parseDeckIdentities } from './images/deck';

// Dev/replay infrastructure
export { Recorder } from './dev/recorder';
export type { TraceEntry, TraceDirection } from './dev/recorder';

// Deep-link (invite) helpers
export { parseJoinHash, inviteUrl } from './deeplink';

// Semantic test harness (§12) — the shared `window.__night` contract
export { createCoreHarness, installHarness, sceneFromState } from './harness';
export type { NightHarness, NightSnapshot, NightScene, SceneActor } from './harness';
