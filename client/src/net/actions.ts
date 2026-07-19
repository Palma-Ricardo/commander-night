// UI-facing command functions (design §4): components call these, never stores.
// Per-command errors surface through the returned promise and render in place
// (deck diagnostics, join failures — design §11); lobby membership itself
// renders from lobby.state events, never from these calls.

import {
  defaultContext, gameAction, gameAnswer, lobbyCreate, lobbyDeck, lobbyJoin, lobbyReady, lobbyStart,
} from '../protocol/commands';
import type { AnswerValue, GameActionValue, Id } from '../protocol/protocol';
import type { Stores } from '../stores';
import { freshGame } from '../stores/game';
import { persistSettings } from '../stores/settings';
import { emptyScratch } from '../stores/prompt';
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

  // Design §7: every UI binding passes the promptId it rendered with; a click
  // that lands after a supersede is dropped here (and would be fenced
  // server-side as PROMPT_STALE anyway — swallowed silently either way).
  // Submitting sets `inflight`; it stays set until game.promptDone or the
  // superseding prompt clears it in route — only an error that leaves the same
  // prompt pending (INVALID_ANSWER, timeout) re-enables the dock here.
  async function answerPrompt(promptId: number, answer: AnswerValue): Promise<void> {
    const { pending, inflight } = stores.prompt.getState();
    const gameId = stores.game.getState().state?.gameId;
    if (pending === undefined || pending.promptId !== promptId || inflight || gameId === undefined) return;
    stores.prompt.setState({
      inflight: true,
      // the acted-on object gets the spinner badge (§7)
      ...(answer.type === 'object' ? { actedOn: answer.objectId } : {}),
    });

    const clearInflightIfStillPending = () => {
      if (stores.prompt.getState().pending?.promptId === promptId) {
        stores.prompt.setState({ inflight: false });
      }
    };
    try {
      const reply = await manager.send(gameAnswer(ctx, { gameId, promptId, answer }));
      if (reply.t === 'error') {
        if (reply.code !== 'PROMPT_STALE') console.warn('[answer]', reply.code, reply.message);
        clearInflightIfStillPending();
      }
    } catch (e) {
      console.warn('[answer]', e);
      clearInflightIfStillPending();
    }
  }

  /** §9 game.action sender (no prompt required). State-reflected effects
   *  (me.skip) render from the server echo, never from the call. */
  async function sendGameAction(action: GameActionValue): Promise<void> {
    const gameId = stores.game.getState().state?.gameId;
    if (gameId === undefined) return;
    unwrap(await manager.send(gameAction(ctx, { gameId, action })));
  }

  return {
    answerPrompt,
    sendGameAction,

    /** Skip menu (§7): the active toggle renders from me.skip — the server
     *  clears skips on its own, and skip:'stack' on an empty stack is a
     *  server no-op; state is the only truth. */
    async setSkip(mode: 'stack'|'endOfTurn'|'nextMain'|'myNextTurn'|'endStepBeforeMyTurn'|'cancel'): Promise<void> {
      await sendGameAction({ kind: 'skip', mode });
    },

    /** autoMana has no state echo (§9) — the game store holds the
     *  ack-confirmed last value instead (server default ON). */
    async setAutoMana(enabled: boolean): Promise<void> {
      await sendGameAction({ kind: 'autoMana', enabled });
      stores.game.setState({ autoMana: enabled });
    },

    /** Gated by GameState.rollbackTurnsAllowed (§6) — the UI hides this
     *  entirely when false (any AI-filled table). */
    async requestRollback(turns: number): Promise<void> {
      await sendGameAction({ kind: 'requestRollback', turns });
    },

    async resetTriggerOrder(): Promise<void> {
      await sendGameAction({ kind: 'triggerOrder', mode: 'reset' });
    },

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

    /** chooseTargets scratch: toggle a candidate in/out, capped at `max`. */
    toggleTarget(promptId: number, id: Id): void {
      const { pending, inflight, selected } = stores.prompt.getState();
      if (pending?.kind !== 'chooseTargets' || pending.promptId !== promptId || inflight) return;
      if (!pending.candidates.includes(id)) return;
      if (selected.includes(id)) {
        stores.prompt.setState({ selected: selected.filter(s => s !== id) });
      } else if (selected.length < pending.max) {
        stores.prompt.setState({ selected: [...selected, id] });
      }
    },

    /** payMana source click: one round trip; records the no-progress probe (§7). */
    async clickManaSource(promptId: number, sourceId: Id): Promise<void> {
      const { pending, inflight } = stores.prompt.getState();
      if (pending?.kind !== 'payMana' || pending.promptId !== promptId || inflight) return;
      stores.prompt.setState({ manaProbe: { sourceId, remaining: pending.remaining } });
      await answerPrompt(promptId, { type: 'object', objectId: sourceId });
    },

    /** Concede (§9, no prompt required). The UI gates this behind type-to-confirm. */
    async concede(): Promise<void> {
      await sendGameAction({ kind: 'concede' });
    },

    /** Post-game "play again" (protocol §5): a started lobby has already
     *  released its members, so rematch = walk back home and create/join a
     *  fresh one (name + deck text persist). Pure local reset — the session
     *  and socket stay up. */
    leaveGame(): void {
      stores.game.setState(freshGame());
      stores.log.setState({ entries: [] });
      stores.prompt.setState({ pending: undefined, ...emptyScratch() });
      stores.lobby.setState({ state: undefined });
    },

    /** Debug toggle (§6/§12); takes effect on the next connect's hello. */
    toggleKeyframesMode(): void {
      const next = { keyframesMode: !stores.settings.getState().keyframesMode };
      stores.settings.setState(next);
      persistSettings(kv, next);
    },
  };
}
