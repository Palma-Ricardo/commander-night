// Server-message routing (design §4): socket.onmessage → codec.decode → route to
// owning store. This module is the single place server events mutate stores;
// replay (C1+) reuses it to re-drive stores headlessly.

import type { LogEntry, ServerMsg } from '../protocol/protocol';
import { applyKeyframe, applyStatePatch } from '../state/apply';
import type { Stores } from '../stores';
import { emptyScratch } from '../stores/prompt';
import type { PendingCommands } from './pending';
import type { SessionWriter } from './session';

const LOG_RING = 500;

export interface RouteCtx {
  stores: Stores;
  pending: PendingCommands;
  session: SessionWriter;
  /** Ask the server for a keyframe (game.resync). Wired by the socket manager. */
  requestResync(): void;
  /** Re-send hello on the open socket (RESUME_FAILED fallback, §5). */
  rehello(): void;
  /** Dev keyframe-verify probe (§6) — dev builds and tests. */
  devVerify: boolean;
}

export function route(msg: ServerMsg, ctx: RouteCtx): void {
  const { stores } = ctx;
  switch (msg.t) {
    case 'session.welcome': {
      ctx.session.onWelcome(msg);
      stores.connection.setState({ status: 'ready', attempt: 0, lastError: undefined });
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
        // would loop forever, so it parks in helloSent instead. Recovery join
        // + toast land in C4 (§10/§11).
        console.warn('[bridge]', msg.code, msg.message);
        const hadAnchor = stores.session.getState().resume !== undefined;
        ctx.session.clearResumeAnchor();
        if (hadAnchor) ctx.rehello();
      } else if (!settled) {
        // Unsolicited non-fatal error; toast surface lands in C4 (§11)
        console.warn('[bridge]', msg.code, msg.message);
      }
      return;
    }

    case 'lobby.state': {
      stores.lobby.setState({ state: msg });
      return;
    }

    case 'game.state': {
      // state/apply owns the keyframe/patch discipline (§6). Neither case
      // touches the prompt store: mid-game keyframes arrive with a prompt
      // still pending, and on resume the re-emitted prompt follows the
      // keyframe (protocol §14).
      applyKeyframe(msg, ctx);
      ctx.session.setResumeAnchor({ gameId: msg.gameId, lastSeq: msg.seq });
      return;
    }

    case 'game.patch': {
      applyStatePatch(msg, ctx);
      // The anchor advances even past a gated/failed patch: resume state comes
      // from the keyframe regardless; lastSeq only trims log backfill (§14).
      ctx.session.setResumeAnchor({ gameId: msg.gameId, lastSeq: msg.seq });
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
      appendLog(stores, msg);
      ctx.session.setResumeAnchor({ gameId: msg.gameId, lastSeq: msg.seq });
      return;
    }

    case 'game.over': {
      stores.game.setState({ over: msg });
      // The game stays browsable through teardown grace (§14); the anchor is
      // cleared so a later visit doesn't try to resume a torn-down game. C4
      // refines this (post-game screen still allows resume within grace).
      ctx.session.clearResumeAnchor();
      return;
    }
  }
}

function appendLog(stores: Stores, entry: LogEntry): void {
  const cur = stores.log.getState().entries;
  if (cur.some(e => e.seq === entry.seq)) return;   // backfill duplicates (§14)
  const next = [...cur, entry].sort((a, b) => a.seq - b.seq).slice(-LOG_RING);
  stores.log.setState({ entries: next });
}
