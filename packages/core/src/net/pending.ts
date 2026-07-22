// Command → ack/error tracking (design §5), C4-complete: correlation, the 8 s
// timeout with retry-once-same-id while the socket is open (the bridge's
// idempotency LRU replays the recorded reply without re-executing, protocol
// §14), park on drop, and in-order flush after resume. A retried game.answer
// that lost its moment comes back PROMPT_STALE — the answer path swallows it.

import type { Ack, ClientMsg, Err } from '../protocol/protocol';

export type CommandReply = Ack | Err;

/** Hands a command to the wire; false when the socket is not open. */
export type Transmit = (cmd: ClientMsg) => boolean;

interface Entry {
  cmd: ClientMsg;
  resolve(reply: CommandReply): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout> | null;   // null while parked
  retried: boolean;
  parked: boolean;
}

const TIMEOUT_MS = 8000;

export class PendingCommands {
  // Map iteration order is insertion order — the §5 in-order flush relies on it.
  private entries = new Map<string, Entry>();

  constructor(private transmit: Transmit, private timeoutMs: number = TIMEOUT_MS) {}

  /** Transmit a command and track it until its ack/error. */
  send(cmd: ClientMsg): Promise<CommandReply> {
    return new Promise<CommandReply>((resolve, reject) => {
      const entry: Entry = { cmd, resolve, reject, timer: null, retried: false, parked: false };
      this.entries.set(cmd.id, entry);
      this.transmit(cmd);
      this.arm(entry);
    });
  }

  /** Track a command without transmitting — it rides the next flush() (§5:
   *  socket dropped → park, flush unacked commands in order after resume). */
  park(cmd: ClientMsg): Promise<CommandReply> {
    return new Promise<CommandReply>((resolve, reject) => {
      this.entries.set(cmd.id, { cmd, resolve, reject, timer: null, retried: false, parked: true });
    });
  }

  /** Route an ack/error to its command. False when nothing matched (e.g. an
   *  unsolicited error — the caller decides what to do with those). */
  settle(reply: CommandReply): boolean {
    const re = reply.re;
    if (re === undefined) return false;
    const entry = this.entries.get(re);
    if (!entry) return false;
    this.entries.delete(re);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.resolve(reply);
    return true;
  }

  /** Socket dropped with a reconnect coming: keep every promise alive. */
  parkAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = null;
      entry.parked = true;
    }
  }

  /** After resume (welcome): transmit parked commands in send order. */
  flush(): void {
    for (const entry of this.entries.values()) {
      if (!entry.parked) continue;
      entry.parked = false;
      this.transmit(entry.cmd);
      this.arm(entry);
    }
  }

  /** Terminal states only (bumped/fatal/manual close): nothing will flush. */
  rejectAll(reason: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.reject(new Error(`command ${id}: ${reason}`));
    }
    this.entries.clear();
  }

  private arm(entry: Entry): void {
    entry.timer = setTimeout(() => {
      if (entry.retried) {
        this.entries.delete(entry.cmd.id);
        entry.reject(new Error(`command ${entry.cmd.id} timed out after ${this.timeoutMs} ms`));
        return;
      }
      entry.retried = true;
      if (this.transmit(entry.cmd)) {
        this.arm(entry);       // same id — the bridge's LRU replays a lost reply
      } else {
        entry.timer = null;    // socket died under us; onClose's parkAll is
        entry.parked = true;   // idempotent with this
      }
    }, this.timeoutMs);
  }

  get size(): number {
    return this.entries.size;
  }
}
