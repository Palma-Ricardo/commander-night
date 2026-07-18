// Command → ack/error tracking (design §5). C1 scope: correlation + timeout.
// The §5 retry-once-same-id and park-and-flush-after-resume behaviors are C4
// ("retry/idempotent flush"); until then a timeout or drop rejects and the UI
// surfaces it inline.

import type { Ack, Err } from '../protocol/protocol';

export type CommandReply = Ack | Err;

interface Entry {
  resolve(reply: CommandReply): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const TIMEOUT_MS = 8000;

export class PendingCommands {
  private inflight = new Map<string, Entry>();

  constructor(private timeoutMs: number = TIMEOUT_MS) {}

  /** Register a sent command id; resolves on the matching ack/error. */
  track(id: string): Promise<CommandReply> {
    return new Promise<CommandReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inflight.delete(id);
        reject(new Error(`command ${id} timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.inflight.set(id, { resolve, reject, timer });
    });
  }

  /** Route an ack/error to its command. False when nothing matched (e.g. an
   *  unsolicited error — the caller decides what to do with those). */
  settle(reply: CommandReply): boolean {
    const re = reply.re;
    if (re === undefined) return false;
    const entry = this.inflight.get(re);
    if (!entry) return false;
    this.inflight.delete(re);
    clearTimeout(entry.timer);
    entry.resolve(reply);
    return true;
  }

  /** Socket dropped: fail everything in flight (C4 parks instead). */
  rejectAll(reason: string): void {
    for (const [id, entry] of this.inflight) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`command ${id}: ${reason}`));
    }
    this.inflight.clear();
  }

  get size(): number {
    return this.inflight.size;
  }
}
