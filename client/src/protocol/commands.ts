// Command builders — the only place client → server messages are constructed.
//
// The id mint and clock are injected (design §3) so tests can pin them; the corpus
// mirror test reproduces every client → server sample byte-for-byte (modulo key
// order) through these builders. Protocol §3: command ids MUST be unique per
// session across reconnects — hence randomUUID, never a counter.

import type {
  Answer, AnswerValue, ChatSend, GameAction, GameActionValue, Hello, Id,
  LobbyCreate, LobbyDeck, LobbyJoin, LobbyReady, LobbyStart, Resync,
} from './protocol';

export interface CommandContext {
  mintId(): string;
  now(): number;
}

export function defaultContext(): CommandContext {
  return {
    mintId: () => crypto.randomUUID(),
    now: () => Date.now(),
  };
}

export function hello(
  ctx: CommandContext,
  opts: { token?: string; resume?: { gameId: Id; lastSeq: number }; stateMode?: 'keyframes' } = {},
): Hello {
  return {
    t: 'session.hello',
    id: ctx.mintId(),
    v: 1,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
    ...(opts.stateMode !== undefined ? { stateMode: opts.stateMode } : {}),
  };
}

export function lobbyCreate(ctx: CommandContext, opts: { name?: string } = {}): LobbyCreate {
  return {
    t: 'lobby.create',
    id: ctx.mintId(),
    format: 'commander-ffa',
    ...(opts.name !== undefined ? { name: opts.name } : {}),
  };
}

export function lobbyJoin(ctx: CommandContext, opts: { code: string; displayName: string }): LobbyJoin {
  return { t: 'lobby.join', id: ctx.mintId(), code: opts.code, displayName: opts.displayName };
}

export function lobbyDeck(ctx: CommandContext, opts: { format: 'dck' | 'list'; content: string }): LobbyDeck {
  return { t: 'lobby.deck', id: ctx.mintId(), format: opts.format, content: opts.content };
}

export function lobbyReady(ctx: CommandContext, opts: { ready: boolean }): LobbyReady {
  return { t: 'lobby.ready', id: ctx.mintId(), ready: opts.ready };
}

export function lobbyStart(ctx: CommandContext, opts: { fillAI?: boolean } = {}): LobbyStart {
  return {
    t: 'lobby.start',
    id: ctx.mintId(),
    ...(opts.fillAI !== undefined ? { fillAI: opts.fillAI } : {}),
  };
}

export function gameResync(ctx: CommandContext, opts: { gameId: Id }): Resync {
  return { t: 'game.resync', id: ctx.mintId(), gameId: opts.gameId };
}

export function gameAnswer(
  ctx: CommandContext,
  opts: { gameId: Id; promptId: number; answer: AnswerValue },
): Answer {
  return { t: 'game.answer', id: ctx.mintId(), gameId: opts.gameId, promptId: opts.promptId, answer: opts.answer };
}

export function gameAction(ctx: CommandContext, opts: { gameId: Id; action: GameActionValue }): GameAction {
  return { t: 'game.action', id: ctx.mintId(), gameId: opts.gameId, action: opts.action };
}

export function chatSend(ctx: CommandContext, opts: { gameId: Id; text: string }): ChatSend {
  return { t: 'chat.send', id: ctx.mintId(), gameId: opts.gameId, text: opts.text };
}
