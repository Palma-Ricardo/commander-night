// T2 exit criterion (design §12, §13): a recorded session replays as continuous
// motion with zero teleports; presented converges to authoritative; the budget
// cap is respected under a synthetic burst. Driven through @night/core (apply →
// game store → lastEvents) and the director, exactly as the app wires it.

import { describe, expect, it } from 'vitest';
import { applyKeyframe, type GameEvent, type GameState, type StateKeyframe } from '@night/core';
import { createStores, type Stores } from '@night/core/stores';
import { memoryKV } from '@night/core/stores/storage';
import { Director, BASE_STEP_MS, type DirectorSink } from '../src/scene/Director';
import { seatView } from '../src/camera/camera';
import { accumulateStackLinks, layoutKeyed, type StackLinks } from '../src/scene/keys';
import { demoSession } from './session-fixture';
import type { Size } from '../src/layout/types';

const VP: Size = { w: 1920, h: 1080 };

function spy() {
  const transitions: { to: GameState; events: readonly GameEvent[]; duration: number }[] = [];
  const sink: DirectorSink = {
    applyTransition(to, _from, events, duration) { transitions.push({ to, events, duration }); },
    frame() {},
  };
  return { dir: new Director(sink, { viewport: VP }), transitions };
}

function drain(dir: Director, capMs = 20_000): number {
  let ms = 0;
  while (!dir.settled && ms < capMs) { dir.tick(16); ms += 16; }
  return ms;
}

/** Apply one full state as a keyframe carrying its events, then hand the store's
 *  fresh state + lastEvents to the director — the exact TableCanvas wiring. */
function feed(stores: Stores, dir: Director, seq: number, state: GameState, events: GameEvent[]): void {
  const kf: StateKeyframe = { t: 'game.state', seq, gameId: state.gameId, state, events };
  applyKeyframe(kf, { stores, requestResync: () => {}, devVerify: false });
  const g = stores.game.getState();
  dir.present(g.state!, g.lastEvents);
}

describe('recorded session — continuity (§13: zero teleports)', () => {
  it('every visible move keeps one tracked actor across the transition', () => {
    const { initial, steps } = demoSession();
    const links: StackLinks = new Map();
    let prev = initial;

    for (const step of steps) {
      const before = layoutKeyed(prev, VP, new Map(links));
      accumulateStackLinks(links, step.events);
      const after = layoutKeyed(step.state, VP, links);

      for (const e of step.events) {
        if (e.k !== 'move') continue;
        // The object lands as an actor at its destination — never dropped.
        expect(after.has(e.objectId), `${step.label}: ${e.objectId} present after`).toBe(true);
        // If it was visible before (any zone but the anonymous library), it is
        // the *same* actor key on both sides → the director tweens it, no
        // create+destroy teleport. This is the whole point of §3/§6.1.
        if (e.from !== 'library') {
          expect(before.has(e.objectId), `${step.label}: ${e.objectId} present before`).toBe(true);
        }
      }
      prev = step.state;
    }
  });
});

describe('recorded session — through core + director (§12 replay tier)', () => {
  it('replays every step as motion, converges to authoritative, synthesizes nothing', () => {
    const { initial, steps } = demoSession();
    const stores = createStores(memoryKV());
    const { dir, transitions } = spy();

    feed(stores, dir, 100, initial, []);
    drain(dir);
    const presentedSeen: (GameState | undefined)[] = [dir.presented];

    steps.forEach((step, i) => {
      feed(stores, dir, 101 + i, step.state, step.events);
      drain(dir);
      presentedSeen.push(dir.presented);
    });

    const real = [initial, ...steps.map(s => s.state)];
    // no dropped steps: presented visited every real state, in order
    expect(presentedSeen).toEqual(real);
    // converged
    expect(dir.presented).toBe(steps.at(-1)!.state);
    // every event-bearing step ran as an animation (nothing snapped in a drained replay)
    expect(transitions.filter(t => t.duration > 0)).toHaveLength(steps.length);
    // zero synthesized states: every applied `to` is one the server sent
    for (const t of transitions) expect(real).toContain(t.to);
    // the turn change re-framed the camera onto Marta — the next to play (display seat 1)
    expect(dir.cameraView()).toEqual(seatView(1));
  });

  it('budget cap respected under a synthetic burst', () => {
    const { initial, steps } = demoSession();
    const stores = createStores(memoryKV());
    const { dir, transitions } = spy();

    feed(stores, dir, 100, initial, []);
    drain(dir);

    // the whole game lands in one frame, faster than animation can play it
    steps.forEach((step, i) => feed(stores, dir, 101 + i, step.state, step.events));
    expect(dir.queueDepth).toBeGreaterThan(0);

    const ms = drain(dir);
    expect(dir.presented).toBe(steps.at(-1)!.state);          // still converges
    expect(ms).toBeLessThan(4 * BASE_STEP_MS);                // bounded, not steps×BASE
    expect(transitions.some(t => t.duration === 0 && t.events.length > 0)).toBe(true);  // dropped some
    for (const t of transitions) expect([initial, ...steps.map(s => s.state)]).toContain(t.to);
  });
});
