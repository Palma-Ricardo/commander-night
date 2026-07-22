// Session recorder (design §12) — the client-side analog of the bridge's callback
// tap: every decoded inbound message and every outbound command lands in a ring
// (last ~2,000 entries), downloadable as JSONL from the debug panel and replayable
// via dev/replay.ts. Framework-free; React reads it via subscribe/entries
// (useSyncExternalStore-compatible: entries() returns a stable reference until
// the next record()).

export type TraceDirection = 'in' | 'out';

export interface TraceEntry {
  n: number;                 // monotonic across ring wraps — stable UI keys
  dir: TraceDirection;
  ts: number;
  msg: unknown;              // the parsed JSON message, as the wire saw it
}

const DEFAULT_CAPACITY = 2000;

export class Recorder {
  private readonly capacity: number;
  private readonly now: () => number;
  private ring: TraceEntry[] = [];
  private next = 0;
  private listeners = new Set<() => void>();
  private snapshot: readonly TraceEntry[] | null = [];

  constructor(opts: { capacity?: number; now?: () => number } = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.now = opts.now ?? (() => Date.now());
  }

  record(dir: TraceDirection, msg: unknown): void {
    this.ring.push({ n: this.next++, dir, ts: this.now(), msg });
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity);
    this.snapshot = null;
    for (const l of this.listeners) l();
  }

  /** Oldest → newest. Reference-stable between records. */
  entries(): readonly TraceEntry[] {
    if (this.snapshot === null) this.snapshot = [...this.ring];
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  toJsonl(): string {
    return this.ring.map(e => JSON.stringify(e)).join('\n');
  }

  clear(): void {
    this.ring = [];
    this.snapshot = null;
    for (const l of this.listeners) l();
  }
}

/** The app-wide recorder. Dev builds record unconditionally (design §12). */
export const recorder = new Recorder();
