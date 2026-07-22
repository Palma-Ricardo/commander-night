// Session persistence writer (design §5): token/identity, resume anchor.
// The only writer of the session store's protocol-owned fields; display name
// and deck text are written through net/actions (user input, also persisted).

import type { Welcome } from '../protocol/protocol';
import type { ResumeAnchor, Stores } from '../stores';
import { KEYS, type KV } from '../stores/storage';

const RESUME_THROTTLE_MS = 1000;   // §5: staleness only costs duplicate backfill

export class SessionWriter {
  private lastResumeWrite = 0;

  constructor(private stores: Stores, private kv: KV, private now: () => number = Date.now) {}

  onWelcome(w: Welcome): void {
    if (w.token !== undefined) this.kv.set(KEYS.token, w.token);
    this.stores.session.setState({
      userId: w.userId,
      ...(w.token !== undefined ? { token: w.token } : {}),
    });
  }

  /** Throttled (1 s) persist; in-memory state always updates. */
  setResumeAnchor(anchor: ResumeAnchor): void {
    const prev = this.stores.session.getState().resume;
    this.stores.session.setState({ resume: anchor });
    const t = this.now();
    if (prev?.gameId !== anchor.gameId || t - this.lastResumeWrite >= RESUME_THROTTLE_MS) {
      this.lastResumeWrite = t;
      this.kv.set(KEYS.resume, JSON.stringify(anchor));
    }
  }

  clearResumeAnchor(): void {
    this.stores.session.setState({ resume: undefined });
    this.kv.remove(KEYS.resume);
  }
}
