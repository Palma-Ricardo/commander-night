// Server-message routing (design §4): socket.onmessage → codec.decode → route to
// owning store. This module is the single place server events mutate stores;
// replay (C1+) reuses it to re-drive stores headlessly.

import type { LobbyState, LogEntry, ServerMsg } from '../protocol/protocol';
import { applyKeyframe, applyStatePatch } from '../state/apply';
import type { Stores } from '../stores';
import { pushNotice } from '../stores/notices';
import { emptyScratch } from '../stores/prompt';
import type { PendingCommands } from './pending';
import type { SessionWriter } from './session';

const LOG_RING = 500;

/** §11's silent set: fenced-late answers and per-command errors that already
 *  render in place (deck diagnostics, join failures) never toast. */
const SILENT_ERRORS = new Set(['PROMPT_STALE']);

export interface RouteCtx {
  stores: Stores;
  pending: PendingCommands;
  session: SessionWriter;
  /** Ask the server for a keyframe (game.resync). Wired by the socket manager. */
  requestResync(): void;
  /** Re-send hello on the open socket (RESUME_FAILED fallback, §5). */
  rehello(): void;
  /** Transmit commands parked during the drop, in order (§5). */
  flushParked(): void;
  /** Dev keyframe-verify probe (§6) — dev builds and tests. */
  devVerify: boolean;
}

export function route(msg: ServerMsg, ctx: RouteCtx): void {
  const { stores } = ctx;
  switch (msg.t) {
    case 'session.welcome': {
      ctx.session.onWelcome(msg);
      stores.connection.setState({ status: 'ready', attempt: 0, lastError: undefined });
      // §5: commands parked during the drop go out now, in order. On resume the
      // bridge fences answers by promptId; a fresh session answers them with
      // UNKNOWN_GAME/PROMPT_STALE, which the senders already absorb.
      ctx.flushParked();
      return;
    }

    case 'ack': {
      ctx.pending.settle(msg);   // unmatched acks are idempotent replays — ignore
      return;
    }

    case 'error': {
      const settled = ctx.pending.settle(msg);
      if (msg.fatal) {
        // §12: the seat is unrecoverable on this connection
        stores.connection.setState({ status: 'fatal', lastError: `${msg.code}: ${msg.message}` });
      } else if (msg.code === 'RESUME_FAILED') {
        // §5: the stored anchor names a game this bridge no longer knows (its
        // restart, or post-game teardown). Drop the anchor and hello again on
        // the same socket — an unknown token *without* resume is a fresh
        // session (protocol §14), so the retry is welcomed. Anchorless repeat
        // would loop forever, so it parks in helloSent instead. The user lands
        // on home with an explanation, not a spinner (§10/§15).
        console.warn('[bridge]', msg.code, msg.message);
        const hadAnchor = stores.session.getState().resume !== undefined;
        ctx.session.clearResumeAnchor();
        if (hadAnchor) {
          pushNotice(stores.notices, 'info',
            'Your previous game is no longer available — it ended or the server restarted.');
          ctx.rehello();
        }
      } else if (!settled && !SILENT_ERRORS.has(msg.code)) {
        // Unsolicited non-fatal error → toast (§11)
        console.warn('[bridge]', msg.code, msg.message);
        pushNotice(stores.notices, 'error', msg.message);
      }
      return;
    }

    case 'lobby.state': {
      stores.lobby.setState({ state: msg });
      adoptSeatIdentity(stores, msg);
      return;
    }

    case 'game.state': {
      // state/apply owns the keyframe/patch discipline (§6). Neither case
      // touches the prompt store: mid-game keyframes arrive with a prompt
      // still pending, and on resume the re-emitted prompt follows the
      // keyframe (protocol §14).
      const prevGameId = stores.game.getState().state?.gameId;
      applyKeyframe(msg, ctx);
      if (stores.game.getState().upstreamNotice !== undefined) {
        stores.game.setState({ upstreamNotice: undefined });   // §11: keyframe clears the banner
      }
      if (prevGameId !== msg.gameId) {
        // a different game landed (rematch after reset): purge stray lines
        // from the old game — log seqs are per-game, mixing them breaks the
        // ring's dedupe/order
        const kept = stores.log.getState().entries.filter(e => e.gameId === msg.gameId);
        if (kept.length !== stores.log.getState().entries.length) {
          stores.log.setState({ entries: kept });
        }
      }
      ctx.session.setResumeAnchor({ gameId: msg.gameId, lastSeq: msg.seq });
      return;
    }

    case 'game.patch': {
      applyStatePatch(msg, ctx);
      // The anchor advances even past a gated/failed patch: resume state comes
      // from the keyframe regardless; lastSeq only trims log backfill (§14).
      if (inCurrentGame(stores, msg.gameId)) {
        ctx.session.setResumeAnchor({ gameId: msg.gameId, lastSeq: msg.seq });
      }
      return;
    }

    case 'game.prompt': {
      // §8: a new prompt implicitly supersedes the previous one. Scratch and
      // inflight reset with it (§7) — with one carry-over: a payMana re-ask
      // whose `remaining` did not shrink after a source click proves that
      // source can't pay (§7 "can't pay this" badge); a shrunk cost is
      // progress and clears the badge set.
      const prev = stores.prompt.getState();
      let cantPay: typeof prev.cantPay = [];
      if (msg.kind === 'payMana' && prev.pending?.kind === 'payMana'
          && prev.manaProbe !== undefined && prev.manaProbe.remaining === msg.remaining) {
        cantPay = prev.cantPay.includes(prev.manaProbe.sourceId)
          ? prev.cantPay
          : [...prev.cantPay, prev.manaProbe.sourceId];
      }
      stores.prompt.setState({ pending: msg, ...emptyScratch(), cantPay });
      ctx.session.setResumeAnchor({ gameId: msg.gameId, lastSeq: msg.seq });
      return;
    }

    case 'game.promptDone': {
      const pending = stores.prompt.getState().pending;
      if (pending?.promptId === msg.promptId) {
        stores.prompt.setState({ pending: undefined, ...emptyScratch() });
      }
      return;
    }

    case 'game.log': {
      const appended = appendLog(stores, msg);
      if (appended && msg.kind === 'chat'
          && msg.playerId !== stores.game.getState().state?.me.playerId) {
        // others' chat counts as unread; the chat tab clears it (§8)
        stores.log.setState(s => ({ unreadChat: s.unreadChat + 1 }));
      }
      if (msg.kind === 'status') {
        // §11: bridge-side upstream trouble → board banner, replaced by the
        // next status line, cleared by the next keyframe
        stores.game.setState({ upstreamNotice: msg.text });
      }
      // Guarded: teardown-grace chat from a game already left via rematch/
      // leaveGame must not resurrect the cleared anchor (§10).
      if (inCurrentGame(stores, msg.gameId)) {
        ctx.session.setResumeAnchor({ gameId: msg.gameId, lastSeq: msg.seq });
      }
      return;
    }

    case 'game.over': {
      stores.game.setState({ over: msg });
      // The anchor survives game.over: a finished game stays resumable — and
      // its chat open — through the bridge's teardown grace (protocol §14), so
      // a reload during post-game chat comes back to this screen. A stale
      // anchor after teardown lands on the RESUME_FAILED path above; walking
      // away deliberately (leaveGame/rematch) clears it.
      return;
    }
  }
}

/**
 * protocol §5: a recovery join re-binds the named seat to this session, and
 * "the re-bound session **adopts the seat's `userId`**; the `userId` from the
 * caller's fresh `welcome` is abandoned". The bridge performs that swap
 * silently (`registry.adopt`) — no message announces it — so the client
 * reconciles the same way the bridge matched us: by display name, which is
 * unique within a lobby (duplicate names are rejected at join).
 *
 * Without this a recovered seat is invisible to itself in every later lobby:
 * `seats.find(s => s.userId === userId)` misses, so the ready toggle stays
 * disabled and the seat can never start a game again. Live-caught 2026-07-19
 * — the game screen hid it, because that renders from the seat-scoped
 * `state.me` and never consults `userId`.
 */
function adoptSeatIdentity(stores: Stores, lobby: LobbyState): void {
  const { userId, name } = stores.session.getState();
  if (userId !== undefined && lobby.seats.some(s => s.userId === userId)) return;
  const wanted = name.trim().toLowerCase();
  if (wanted === '') return;
  const mine = lobby.seats.filter(s => s.name.trim().toLowerCase() === wanted);
  if (mine.length === 1 && mine[0]!.userId !== userId) {
    stores.session.setState({ userId: mine[0]!.userId });
  }
}

function inCurrentGame(stores: Stores, gameId: string): boolean {
  return stores.game.getState().state?.gameId === gameId;
}

function appendLog(stores: Stores, entry: LogEntry): boolean {
  const cur = stores.log.getState().entries;
  if (cur.some(e => e.seq === entry.seq)) return false;   // backfill duplicates (§14)
  const next = [...cur, entry].sort((a, b) => a.seq - b.seq).slice(-LOG_RING);
  stores.log.setState({ entries: next });
  return true;
}
