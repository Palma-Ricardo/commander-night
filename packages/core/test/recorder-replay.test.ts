// Recorder ring + replay skeleton tests (design §12).

import { describe, expect, it, vi } from 'vitest';
import { Recorder } from '../src/dev/recorder';
import { replayJsonl } from '../src/dev/replay';

const WELCOME = { t: 'session.welcome', re: 'c1', v: 1, userId: 'u1', role: 'player', resumed: false };
const HELLO = { t: 'session.hello', id: 'c1', v: 1 };

describe('Recorder', () => {
  it('keeps the last `capacity` entries with monotonic n and the injected clock', () => {
    const rec = new Recorder({ capacity: 3, now: () => 42 });
    for (let i = 0; i < 5; i++) rec.record('out', { i });
    const entries = rec.entries();
    expect(entries.map(e => e.n)).toEqual([2, 3, 4]);
    expect(entries.map(e => (e.msg as { i: number }).i)).toEqual([2, 3, 4]);
    expect(entries.every(e => e.ts === 42)).toBe(true);
  });

  it('returns a reference-stable snapshot between records (useSyncExternalStore contract)', () => {
    const rec = new Recorder({ now: () => 0 });
    rec.record('in', WELCOME);
    const a = rec.entries();
    expect(rec.entries()).toBe(a);
    rec.record('out', HELLO);
    expect(rec.entries()).not.toBe(a);
  });

  it('notifies subscribers on record and clear; unsubscribe stops notifications', () => {
    const rec = new Recorder({ now: () => 0 });
    const listener = vi.fn();
    const unsub = rec.subscribe(listener);
    rec.record('in', WELCOME);
    expect(listener).toHaveBeenCalledTimes(1);
    rec.clear();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(rec.entries()).toEqual([]);
    unsub();
    rec.record('in', WELCOME);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('replayJsonl', () => {
  it('re-drives a recorded session through the codec', () => {
    const rec = new Recorder({ now: () => 7 });
    rec.record('out', HELLO);
    rec.record('in', WELCOME);
    const seen: string[] = [];
    const report = replayJsonl(rec.toJsonl(), {
      onServerMsg: m => seen.push(m.t),
      onClientMsg: m => seen.push(`out:${(m as { t: string }).t}`),
    });
    expect(report).toEqual({ lines: 2, inbound: 1, outbound: 1, errors: [] });
    expect(seen).toEqual(['out:session.hello', 'session.welcome']);
  });

  it('reports decode failures and corrupt lines with 1-based line numbers', () => {
    const jsonl = [
      JSON.stringify({ dir: 'in', ts: 0, msg: WELCOME }),
      '{corrupt',
      JSON.stringify({ dir: 'in', ts: 0, msg: { t: 'game.confetti' } }),
      JSON.stringify({ ts: 0, msg: WELCOME }),
    ].join('\n');
    const report = replayJsonl(jsonl);
    expect(report.inbound).toBe(1);
    expect(report.errors.map(e => e.line)).toEqual([2, 3, 4]);
  });
});
