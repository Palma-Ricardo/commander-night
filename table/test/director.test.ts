import { describe, expect, it } from 'vitest';
import type { GameEvent, GameState } from '@night/core';
import { Director, BASE_STEP_MS, type DirectorSink } from '../src/scene/Director';
import { camera, seatView, TABLE_VIEW } from '../src/camera/camera';
import { mkPlayer, mkState } from './helpers';
import type { Size } from '../src/layout/types';

const VP: Size = { w: 1920, h: 1080 };

/** A game state with a chosen id + active player, for driving the clock. */
function game(id: string, activeId = 'p1'): GameState {
  const players = [
    mkPlayer('p1', 'You', { human: true }), mkPlayer('p2', 'Ana'),
    mkPlayer('p3', 'Tom'), mkPlayer('p4', 'Marta'),
  ];
  return {
    ...mkState(players, 'p1', { turn: { n: 1, activePlayerId: activeId, priorityPlayerId: activeId } }),
    gameId: id,
  };
}

const STEP: GameEvent[] = [{ k: 'step', activePlayerId: 'p1' }];

function spy(opts?: ConstructorParameters<typeof Director>[1]) {
  const transitions: { to: GameState; from?: GameState; events: readonly GameEvent[]; duration: number }[] = [];
  let frames = 0;
  const sink: DirectorSink = {
    applyTransition(to, from, events, duration) { transitions.push({ to, from, events, duration }); },
    frame() { frames++; },
  };
  const dir = new Director(sink, { viewport: VP, ...opts });
  return { dir, transitions, frames: () => frames };
}

/** Tick 16 ms steps until settled (or a cap), returning the elapsed ms. */
function drain(dir: Director, capMs = 20_000): number {
  let ms = 0;
  while (!dir.settled && ms < capMs) { dir.tick(16); ms += 16; }
  return ms;
}

describe('Director — the two clocks (§6.3)', () => {
  it('first present snaps: no state to animate from', () => {
    const { dir, transitions } = spy();
    dir.present(game('a'), []);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.duration).toBe(0);
    expect(dir.presented?.gameId).toBe('a');
    expect(dir.settled).toBe(true);
  });

  it('an event-bearing step animates, then advances presented only on completion', () => {
    const { dir } = spy();
    const g0 = game('a'), g1 = game('a');
    dir.present(g0, []);
    dir.present(g1, STEP);
    expect(dir.settled).toBe(false);
    expect(dir.presented).toBe(g0);              // still the old state mid-animation
    dir.tick(BASE_STEP_MS);
    expect(dir.presented).toBe(g1);              // advanced exactly at completion
    expect(dir.settled).toBe(true);
  });

  it('a step with no events snaps (the §7.1 teleport fallback)', () => {
    const { dir, transitions } = spy();
    dir.present(game('a'), []);
    dir.present(game('a'), []);                  // no events → cut
    expect(transitions.at(-1)!.duration).toBe(0);
    expect(dir.settled).toBe(true);
  });

  it('a game change snaps even with events (rematch is not an animation)', () => {
    const { dir, transitions } = spy();
    dir.present(game('a'), []);
    dir.present(game('b'), STEP);                // different gameId
    expect(transitions.at(-1)!.duration).toBe(0);
  });

  it('reduced motion collapses every move to a cut', () => {
    const { dir, transitions } = spy({ reducedMotion: true });
    dir.present(game('a'), []);
    dir.present(game('a'), STEP);
    expect(transitions.at(-1)!.duration).toBe(0);
    expect(dir.settled).toBe(true);
  });

  it('never synthesizes state: presented is always a state it was handed, and converges', () => {
    const { dir, transitions } = spy();
    const states = [game('a'), game('a'), game('a'), game('a')];
    const presentedSeen: (GameState | undefined)[] = [];
    dir.present(states[0]!, []);
    presentedSeen.push(dir.presented);
    for (let i = 1; i < states.length; i++) {
      dir.present(states[i]!, STEP);
      drain(dir);
      presentedSeen.push(dir.presented);
    }
    // visited every real state in order (no dropped steps under drained replay)
    expect(presentedSeen).toEqual(states);
    // converged to authoritative
    expect(dir.presented).toBe(states.at(-1));
    expect(dir.authoritative).toBe(states.at(-1));
    // zero synthesized: every applied `to` is one of the real states
    for (const t of transitions) expect(states).toContain(t.to);
  });
});

describe('Director — catch-up under a burst (§6.3)', () => {
  it('scales durations down as the backlog grows', () => {
    const { dir, transitions } = spy();
    dir.present(game('a'), []);           // settle first
    // queue several at once
    for (let i = 0; i < 5; i++) dir.present(game('a'), STEP);
    drain(dir);
    const animated = transitions.filter(t => t.duration > 0).map(t => t.duration);
    // at least one leg ran shorter than a lone move — the backlog compressed it
    expect(Math.min(...animated)).toBeLessThan(BASE_STEP_MS);
  });

  it('snaps through a deep backlog and still converges (budget cap respected)', () => {
    const { dir, transitions } = spy();
    dir.present(game('a'), []);
    const last = game('a');
    for (let i = 0; i < 40; i++) dir.present(i === 39 ? last : game('a'), STEP);
    expect(dir.queueDepth).toBeGreaterThan(10);     // the backlog really piled up
    const ms = drain(dir);
    expect(dir.presented).toBe(last);               // converged to the newest
    // drain time is bounded independent of the 40-deep burst — most were snapped
    expect(ms).toBeLessThan(4 * BASE_STEP_MS);
    expect(transitions.some(t => t.duration === 0 && t.events.length > 0)).toBe(true);
  });

  it('flush compresses the queue into a hard cap (§6.4)', () => {
    const { dir } = spy();
    dir.present(game('a'), []);
    dir.present(game('a'), STEP);          // animating
    dir.present(game('a'), STEP);          // queued
    const target = game('a');
    dir.present(target, STEP);             // queued
    expect(dir.queueDepth).toBe(2);
    dir.flush(200);
    expect(dir.queueDepth).toBe(0);        // drained: intermediates snapped, last capped
    expect(dir.settled).toBe(false);       // the last leg still plays…
    dir.tick(200);                         // …within the 200 ms budget
    expect(dir.settled).toBe(true);
    expect(dir.presented).toBe(target);
  });

  it('flush caps an in-flight step with an empty queue', () => {
    const { dir } = spy();
    dir.present(game('a'), []);
    const g1 = game('a');
    dir.present(g1, STEP);                  // animating, nothing queued
    dir.flush(100);
    dir.tick(100);
    expect(dir.settled).toBe(true);
    expect(dir.presented).toBe(g1);
  });
});

describe('Director — camera is the director\'s (§7.3)', () => {
  it('stays on the whole table on first sight, then follows the active player', () => {
    const { dir } = spy();
    dir.present(game('a', 'p1'), []);      // baseline — no move on load
    expect(dir.cameraView()).toEqual(TABLE_VIEW);
    dir.present(game('a', 'p2'), STEP);    // turn moves to Ana (display seat 1)
    expect(dir.cameraView()).toEqual(seatView(1));
    drain(dir);
    // the camera preset interpolated all the way to the seat framing
    const want = camera(seatView(1), VP);
    expect(dir.cameraPreset().scale).toBeCloseTo(want.scale, 3);
    expect(dir.cameraPreset().x).toBeCloseTo(want.x, 1);
  });

  it('a manual override is sticky against follow', () => {
    const { dir } = spy();
    dir.present(game('a', 'p1'), []);
    dir.focusSeat(2);
    expect(dir.isFollowing()).toBe(false);
    dir.present(game('a', 'p3'), STEP);    // turn moves — camera stays pinned
    expect(dir.cameraView()).toEqual(seatView(2));
  });

  it('§14: a point the lens cannot see pulls back to the whole table', () => {
    const { dir } = spy();
    dir.present(game('a', 'p1'), []);
    dir.focusSeat(0);                      // pinned bottom-left
    const moved = dir.ensureVisible([{ x: 2200, y: 200 }]);   // deep in the far quadrant
    expect(moved).toBe(true);
    expect(dir.cameraView()).toEqual(TABLE_VIEW);
  });

  it('a manual camera move interpolates rather than cutting', () => {
    const { dir } = spy();
    dir.present(game('a', 'p1'), []);
    const before = dir.cameraPreset().scale;
    dir.focusSeat(1);
    dir.tick(16);                          // one frame in
    const mid = dir.cameraPreset().scale;
    expect(mid).not.toBeCloseTo(before, 4);           // it moved…
    expect(mid).not.toBeCloseTo(camera(seatView(1), VP).scale, 4);   // …but hasn't arrived
  });
});
