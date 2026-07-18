// Server-message routing (design §4): socket.onmessage → codec.decode → route to
// owning store. This module is the single place server events mutate stores;
// replay (C1+) reuses it to re-drive stores headlessly.

import type { LogEntry, ServerMsg } from '../protocol/protocol';
import type { Stores } from '../stores';
import type { PendingCommands } from './pending';
import type { SessionWriter } from './session';

const LOG_RING = 500;

export interface RouteCtx {
  stores: Stores;
  pending: PendingCommands;
  session: SessionWriter;
  /** Ask the server for a keyframe (game.resync). Wired by the socket manager. */
  requestResync(): void;
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
      // Keyframe replaces the tree wholesale (§6; dev deep-equal verify lands
      // with patch mode in C3). Does NOT touch the prompt store: mid-game
      // keyframes arrive with a prompt still pending, and on resume the
      // re-emitted prompt follows the keyframe (protocol §14).
      stores.game.setState({ state: msg.state, lastAppliedSeq: msg.seq, syncMode: 'live' });
      ctx.session.setResumeAnchor({ gameId: msg.gameId, lastSeq: msg.seq });
      return;
    }

    case 'game.patch': {
      // C1 runs keyframes-mode (§6); patch application is C3 (state/apply.ts).
      // A patch here means the server is in patch mode — recover via resync
      // and gate further patches until the keyframe arrives (§6).
      const { syncMode } = stores.game.getState();
      if (syncMode === 'awaitingKeyframe') return;
      console.warn(`[sync] patch seq ${msg.seq} before patch support (C3) — resyncing`);
      stores.game.setState({ syncMode: 'awaitingKeyframe' });
      ctx.requestResync();
      return;
    }

    case 'game.prompt': {
      // §8: a new prompt implicitly supersedes the previous one
      stores.prompt.setState({ pending: msg });
      ctx.session.setResumeAnchor({ gameId: msg.gameId, lastSeq: msg.seq });
      return;
    }

    case 'game.promptDone': {
      const pending = stores.prompt.getState().pending;
      if (pending?.promptId === msg.promptId) stores.prompt.setState({ pending: undefined });
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
