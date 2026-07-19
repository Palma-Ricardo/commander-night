// state/apply.ts — the keyframe/patch discipline (design §6, protocol §7).
//
// game.patch: assert base === lastAppliedSeq, apply with fast-json-patch (the
// compatibility target the bridge's zjsonpatch was restricted to, bridge §1).
// On base mismatch or an op that fails to apply: stop, send game.resync, and
// ignore further patches until the keyframe arrives — events are ordered, so
// this is a clean gate, not a race.
//
// game.state: replaces the tree wholesale. In dev, a keyframe riding directly
// behind an applied patch (consecutive seq — the every-100-patches backstop,
// protocol §7 sends it with the same tree the patch stream produces) is first
// deep-equaled against the locally-patched tree: a free continuous
// zjsonpatch ⇄ fast-json-patch conformance probe on real data. compare()
// reports the mismatched paths when it fires.

import { applyPatch as rfc6902, compare } from 'fast-json-patch';
import type { GameState, StateKeyframe, StatePatch } from '../protocol/protocol';
import type { Stores } from '../stores';

export interface ApplyCtx {
  stores: Stores;
  /** Ask the server for a keyframe (game.resync). */
  requestResync(): void;
  /** Enables the keyframe deep-equal probe — dev builds and tests. */
  devVerify: boolean;
}

export function applyStatePatch(msg: StatePatch, ctx: ApplyCtx): void {
  const g = ctx.stores.game.getState();
  if (g.syncMode === 'awaitingKeyframe') return;   // gated until the keyframe (§6)

  if (g.state === undefined || msg.base !== g.lastAppliedSeq) {
    console.warn(`[sync] patch ${msg.seq} base ${msg.base} ≠ lastAppliedSeq ${g.lastAppliedSeq} — resyncing`);
    gateAndResync(ctx);
    return;
  }

  let next: GameState;
  try {
    // validate + clone: a bad op throws instead of corrupting, and the store
    // swap stays atomic (mutateDocument=false)
    next = rfc6902(g.state, msg.ops, true, false).newDocument;
  } catch (e) {
    console.error('[sync] patch failed to apply — resyncing', e, msg.ops);
    gateAndResync(ctx);
    return;
  }

  ctx.stores.game.setState({
    state: next,
    lastAppliedSeq: msg.seq,
    lastAppliedWasPatch: true,
    counters: { ...g.counters, patches: g.counters.patches + 1 },
  });
}

export function applyKeyframe(msg: StateKeyframe, ctx: ApplyCtx): void {
  const g = ctx.stores.game.getState();
  const counters = { ...g.counters, keyframes: g.counters.keyframes + 1 };

  // §6 dev verify: only a backstop keyframe — same game, seq directly after an
  // applied patch — claims to equal the local tree. Keyframes after resync,
  // reconnect, or another keyframe are new baselines, not claims. Neither is
  // the final keyframe (protocol §11): its status flip to 'over' is never sent
  // as a patch, so it can ride at lastAppliedSeq+1 with a legitimately
  // different tree.
  if (ctx.devVerify && g.syncMode === 'live' && g.lastAppliedWasPatch
      && g.state !== undefined && g.state.gameId === msg.state.gameId
      && msg.seq === g.lastAppliedSeq + 1 && msg.state.status !== 'over') {
    counters.verifies++;
    const diff = compare(g.state, msg.state);
    if (diff.length > 0) {
      counters.divergences++;
      console.error(`[sync] keyframe-verify divergence at seq ${msg.seq}:`, diff);
    }
  }

  ctx.stores.game.setState({
    state: msg.state,
    lastAppliedSeq: msg.seq,
    lastAppliedWasPatch: false,
    syncMode: 'live',
    counters,
  });
}

function gateAndResync(ctx: ApplyCtx): void {
  const g = ctx.stores.game.getState();
  ctx.stores.game.setState({
    syncMode: 'awaitingKeyframe',
    counters: { ...g.counters, resyncs: g.counters.resyncs + 1 },
  });
  ctx.requestResync();
}
