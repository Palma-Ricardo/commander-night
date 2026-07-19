// state/apply tests (design §6): the keyframe/patch discipline — base check,
// gate + resync on mismatch or failed op, patches ignored mid-resync, and the
// dev keyframe-verify probe (exact only for the backstop pair: a keyframe
// riding at seq+1 directly behind an applied patch).

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decode } from '../src/protocol/codec';
import type { StateKeyframe, StatePatch } from '../src/protocol/protocol';
import { applyKeyframe, applyStatePatch, type ApplyCtx } from '../src/state/apply';
import { createStores, type Stores } from '../src/stores';
import { memoryKV } from '../src/stores/storage';

const keyframe = (() => {
  const text = fs.readFileSync(
    fileURLToPath(new URL('../../docs/protocol/samples/game.state.json', import.meta.url)), 'utf8');
  const r = decode(text, { strict: true });
  if (!r.ok || r.msg?.t !== 'game.state') throw new Error('sample did not decode');
  return r.msg as StateKeyframe;
})();

const lifePatch = (seq: number, base: number, life: number): StatePatch => ({
  t: 'game.patch', seq, gameId: 'g1', base,
  ops: [{ op: 'replace', path: '/players/0/life', value: life }],
});

let stores: Stores;
let resyncs: number;
let ctx: ApplyCtx;

beforeEach(() => {
  stores = createStores(memoryKV());
  resyncs = 0;
  ctx = { stores, requestResync: () => resyncs++, devVerify: true };
});

describe('applyStatePatch', () => {
  it('applies onto the matching base and advances lastAppliedSeq', () => {
    applyKeyframe(keyframe, ctx);
    applyStatePatch(lifePatch(3, keyframe.seq, 33), ctx);

    const g = stores.game.getState();
    expect(g.state?.players[0]?.life).toBe(33);
    expect(g.lastAppliedSeq).toBe(3);
    expect(g.lastAppliedWasPatch).toBe(true);
    expect(g.counters).toMatchObject({ patches: 1, keyframes: 1, resyncs: 0 });
    expect(resyncs).toBe(0);
  });

  it('chains: each patch bases on the previous state event', () => {
    applyKeyframe(keyframe, ctx);
    applyStatePatch(lifePatch(3, keyframe.seq, 33), ctx);
    applyStatePatch(lifePatch(5, 3, 30), ctx);   // seq 4 was e.g. a log line
    expect(stores.game.getState().state?.players[0]?.life).toBe(30);
    expect(stores.game.getState().lastAppliedSeq).toBe(5);
  });

  it('base mismatch → gate + one resync; further patches dropped until the keyframe', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    applyKeyframe(keyframe, ctx);
    applyStatePatch(lifePatch(9, 8, 33), ctx);   // base 8 ≠ lastAppliedSeq 2

    let g = stores.game.getState();
    expect(g.syncMode).toBe('awaitingKeyframe');
    expect(g.state?.players[0]?.life).toBe(keyframe.state.players[0]!.life);   // untouched
    expect(resyncs).toBe(1);
    expect(g.counters.resyncs).toBe(1);

    applyStatePatch(lifePatch(10, 9, 32), ctx);   // would even chain — still gated
    expect(resyncs).toBe(1);                       // no resync storm
    expect(stores.game.getState().counters.patches).toBe(0);

    applyKeyframe({ ...keyframe, seq: 11 }, ctx);
    g = stores.game.getState();
    expect(g.syncMode).toBe('live');
    expect(g.lastAppliedSeq).toBe(11);

    applyStatePatch(lifePatch(12, 11, 31), ctx);   // live again
    expect(stores.game.getState().state?.players[0]?.life).toBe(31);
    warn.mockRestore();
  });

  it('a patch before any keyframe gates and resyncs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    applyStatePatch(lifePatch(3, 2, 33), ctx);
    expect(stores.game.getState().syncMode).toBe('awaitingKeyframe');
    expect(resyncs).toBe(1);
    warn.mockRestore();
  });

  it('an op that fails to apply → gate + resync, state untouched', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    applyKeyframe(keyframe, ctx);
    applyStatePatch({
      t: 'game.patch', seq: 3, gameId: 'g1', base: keyframe.seq,
      ops: [{ op: 'remove', path: '/players/7/battlefield/0' }],   // no such player
    }, ctx);

    const g = stores.game.getState();
    expect(g.syncMode).toBe('awaitingKeyframe');
    expect(g.state).toEqual(keyframe.state);
    expect(g.counters).toMatchObject({ patches: 0, resyncs: 1 });
    expect(resyncs).toBe(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('the store swap is atomic — the pre-patch tree is never mutated', () => {
    applyKeyframe(keyframe, ctx);
    const before = stores.game.getState().state!;
    applyStatePatch(lifePatch(3, keyframe.seq, 33), ctx);
    expect(before.players[0]?.life).toBe(keyframe.state.players[0]!.life);
    expect(stores.game.getState().state).not.toBe(before);
  });
});

describe('dev keyframe-verify (§6)', () => {
  it('a backstop keyframe matching the patched tree verifies clean', () => {
    applyKeyframe(keyframe, ctx);
    applyStatePatch(lifePatch(3, keyframe.seq, 33), ctx);
    const patched = stores.game.getState().state!;

    applyKeyframe({ ...keyframe, seq: 4, state: structuredClone(patched) }, ctx);
    const g = stores.game.getState();
    expect(g.counters.verifies).toBe(1);
    expect(g.counters.divergences).toBe(0);
    expect(g.lastAppliedWasPatch).toBe(false);
  });

  it('a mismatched backstop keyframe counts a divergence and reports the paths', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    applyKeyframe(keyframe, ctx);
    applyStatePatch(lifePatch(3, keyframe.seq, 33), ctx);
    const diverged = structuredClone(stores.game.getState().state!);
    diverged.players[0]!.life = 21;

    applyKeyframe({ ...keyframe, seq: 4, state: diverged }, ctx);
    expect(stores.game.getState().counters).toMatchObject({ verifies: 1, divergences: 1 });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('divergence'),
      expect.arrayContaining([expect.objectContaining({ path: '/players/0/life' })]),
    );
    // the keyframe still wins — self-healing over complaining
    expect(stores.game.getState().state?.players[0]?.life).toBe(21);
    error.mockRestore();
  });

  it('does not probe keyframes that are new baselines', () => {
    // after another keyframe (keyframes-only mode / reconnect)
    applyKeyframe(keyframe, ctx);
    applyKeyframe({ ...keyframe, seq: 3 }, ctx);
    expect(stores.game.getState().counters.verifies).toBe(0);

    // after a seq gap (resumed with missed patches)
    applyStatePatch(lifePatch(4, 3, 33), ctx);
    applyKeyframe({ ...keyframe, seq: 9 }, ctx);
    expect(stores.game.getState().counters.verifies).toBe(0);

    // while awaiting a resync keyframe
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    applyStatePatch(lifePatch(20, 19, 30), ctx);   // mismatch → gate
    applyKeyframe({ ...keyframe, seq: 21 }, ctx);
    expect(stores.game.getState().counters.verifies).toBe(0);
    warn.mockRestore();
  });

  it('does not probe the final keyframe — the over flip is never sent as a patch (§11)', () => {
    applyKeyframe(keyframe, ctx);
    applyStatePatch(lifePatch(3, keyframe.seq, 33), ctx);
    const finalState = structuredClone(stores.game.getState().state!);
    finalState.status = 'over';
    applyKeyframe({ ...keyframe, seq: 4, state: finalState }, ctx);
    expect(stores.game.getState().counters).toMatchObject({ verifies: 0, divergences: 0 });
  });

  it('is off in prod (devVerify false)', () => {
    ctx = { ...ctx, devVerify: false };
    applyKeyframe(keyframe, ctx);
    applyStatePatch(lifePatch(3, keyframe.seq, 33), ctx);
    applyKeyframe({ ...keyframe, seq: 4, state: structuredClone(stores.game.getState().state!) }, ctx);
    expect(stores.game.getState().counters.verifies).toBe(0);
  });
});
