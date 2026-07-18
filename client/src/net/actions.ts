// UI-facing command functions (design §4): components call these, never stores.
// Per-command errors surface through the returned promise and render in place
// (deck diagnostics, join failures — design §11); lobby membership itself
// renders from lobby.state events, never from these calls.

import {
  defaultContext, lobbyCreate, lobbyDeck, lobbyJoin, lobbyReady, lobbyStart,
} from '../protocol/commands';
import type { Stores } from '../stores';
import { KEYS, type KV } from '../stores/storage';
import type { CommandReply } from './pending';
import type { SocketManager } from './socket';

export class CommandError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function unwrap(reply: CommandReply): void {
  if (reply.t === 'error') throw new CommandError(reply.code, reply.message);
}

export type Actions = ReturnType<typeof createActions>;

export function createActions(stores: Stores, manager: SocketManager, kv: KV) {
  const ctx = defaultContext();

  function requireName(): string {
    const name = stores.session.getState().name.trim();
    if (!name) throw new CommandError('LOBBY_STATE', 'pick a display name first');
    return name;
  }

  /** The lobby code arrives via the lobby.state broadcast after create (§5). */
  function waitForLobbyCode(previous: string | undefined, timeoutMs = 5000): Promise<string> {
    const current = stores.lobby.getState().state?.code;
    if (current !== undefined && current !== previous) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error('lobby created but no lobby.state arrived'));
      }, timeoutMs);
      const unsub = stores.lobby.subscribe(s => {
        const code = s.state?.code;
        if (code !== undefined && code !== previous) {
          clearTimeout(timer);
          unsub();
          resolve(code);
        }
      });
    });
  }

  return {
    setDisplayName(name: string): void {
      stores.session.setState({ name });
      kv.set(KEYS.name, name);
    },

    setDeckText(text: string): void {
      stores.session.setState({ deckText: text });
      kv.set(KEYS.deck, text);
    },

    /** lobby.create seats nobody (the host learns the code from lobby.state,
     *  then takes a seat like everyone else) — so create chains into join. */
    async createLobby(lobbyName?: string): Promise<string> {
      const name = requireName();
      const before = stores.lobby.getState().state?.code;
      unwrap(await manager.send(lobbyCreate(ctx, lobbyName !== undefined ? { name: lobbyName } : {})));
      const code = await waitForLobbyCode(before);
      unwrap(await manager.send(lobbyJoin(ctx, { code, displayName: name })));
      return code;
    },

    async joinLobby(code: string): Promise<void> {
      const name = requireName();
      unwrap(await manager.send(lobbyJoin(ctx, { code: code.trim().toUpperCase(), displayName: name })));
    },

    /** Submit the session's deck text. Resolves on ack — the parse verdict
     *  (valid/cards/commander/problems) arrives on the next lobby.state. */
    async submitDeck(): Promise<void> {
      const content = stores.session.getState().deckText;
      unwrap(await manager.send(lobbyDeck(ctx, { format: 'dck', content })));
    },

    async setReady(ready: boolean): Promise<void> {
      unwrap(await manager.send(lobbyReady(ctx, { ready })));
    },

    async startGame(fillAI: boolean): Promise<void> {
      unwrap(await manager.send(lobbyStart(ctx, fillAI ? { fillAI } : {})));
    },

    /** Debug toggle (§6/§12); takes effect on the next connect's hello. */
    toggleKeyframesMode(): void {
      const next = { keyframesMode: !stores.settings.getState().keyframesMode };
      stores.settings.setState(next);
      kv.set(KEYS.settings, JSON.stringify(next));
    },
  };
}
