// The director (design §6.3) — the join between the two clocks. The bridge emits
// state at machine speed; animation has duration. The director consumes
// `(events, nextState)` steps, plays them as timed transitions, and only then
// advances the *presented* state (the older, real state the scene depicts) toward
// the *authoritative* state (the latest the core holds).
//
// Invariant (§6.3): **the director never synthesizes state.** `presented` is
// always a GameState the server actually sent — never an interpolation of two.
// Only *transforms* interpolate (in the actors); the director just decides which
// real state the scene is easing toward, and when it has arrived. That makes an
// entire class of "the board briefly showed something illegal" bug
// unrepresentable, and it makes the whole clock testable with a fake `now`.
//
// Catch-up (§6.3): XMage outruns animation, so the director scales durations down
// as the backlog grows and, past a threshold, snaps through everything but the
// newest step and animates only that last leg. Dropping animation is always legal
// (§7.1: events are advisory). `flush` (§6.4) is the same idea under a hard cap,
// for when a prompt for this seat needs the board caught up *now*.
//
// This file is Pixi-free: it drives a `DirectorSink` (the scene implements it
// with real CardActors; tests implement it with a spy). Pure clock + queue.

import type { GameEvent, GameState } from '@night/core';
import { seatOfPlayer } from '../layout/world';
import type { Size } from '../layout/types';
import {
  camera, lerpPreset, seatView, TABLE_VIEW, type CameraPreset, type CameraView,
} from '../camera/camera';
import { CameraController } from '../camera/controller';
import { accumulateStackLinks, pruneStackLinks, type StackLinks } from './keys';
import type { Point } from '../layout/types';

/** One presented-state transition, applied to the scene over `durationMs`
 *  (0 ⇒ snap). `from` is the previously-presented state (undefined on first
 *  paint); `links` is the live stackLink map, already folded for this step. */
export interface DirectorSink {
  applyTransition(
    to: GameState,
    from: GameState | undefined,
    events: readonly GameEvent[],
    durationMs: number,
    links: StackLinks,
  ): void;
  /** Per-frame: advance actor tweens by `dtMs` and apply the interpolated camera. */
  frame(dtMs: number, cameraPreset: CameraPreset): void;
}

interface Step { state: GameState; events: readonly GameEvent[] }

export const BASE_STEP_MS = 300;    // a normal move at an empty backlog
const CAMERA_MANUAL_MS = 260;       // a user-driven camera move (1–4 / compass / Esc)
const DROP_THRESHOLD = 3;           // backlog past which we snap all but the newest
const MIN_STEP_MS = 90;             // durations never scale below this while animating
const DEFAULT_FLUSH_MS = 400;       // §6.4 budgeted-flush cap

export interface DirectorOpts {
  viewport?: Size;
  reducedMotion?: boolean;          // prefers-reduced-motion → every move is a cut
}

const ease = (t: number): number => 1 - (1 - t) ** 3;

export class Director {
  private readonly controller = new CameraController();
  private readonly links: StackLinks = new Map();
  private viewport: Size;
  private reducedMotion: boolean;
  private rightInset = 0;                  // width the open log steals from the right (§8)

  // ── the two clocks ──
  private presentedState?: GameState;     // last *settled* real state
  private queue: Step[] = [];             // real states waiting to be presented
  private stepActive = false;
  private stepElapsed = 0;
  private stepDuration = 0;
  private pendingTarget?: GameState;       // the real state the active step eases toward

  // ── the camera tween ──
  private camFrom: CameraPreset;
  private camTo: CameraPreset;
  private camElapsed = 0;
  private camDuration = 0;

  constructor(private readonly sink: DirectorSink, opts: DirectorOpts = {}) {
    this.viewport = opts.viewport ?? { w: 1920, h: 1080 };
    this.reducedMotion = opts.reducedMotion ?? false;
    this.camFrom = camera(TABLE_VIEW, this.viewport, this.rightInset);
    this.camTo = this.camFrom;
  }

  // ── ingest ─────────────────────────────────────────────────────────────────

  /** Enqueue a step. Starts immediately when idle (so first paint and the
   *  caught-up case are instant); otherwise it queues and `tick` drives it. */
  present(state: GameState, events: readonly GameEvent[] = []): void {
    this.queue.push({ state, events });
    if (!this.stepActive) this.startNextStep();
  }

  // ── the frame loop ───────────────────────────────────────────────────────────

  /** Advance both clocks by `dtMs`, then paint. The sole driver of motion. */
  tick(dtMs: number): void {
    if (this.camDuration > 0) {
      this.camElapsed += dtMs;
      if (this.camElapsed >= this.camDuration) { this.camDuration = 0; this.camFrom = this.camTo; }
    }
    if (this.stepActive) {
      this.stepElapsed += dtMs;
      if (this.stepElapsed >= this.stepDuration) {
        this.settle(this.pendingTarget!);
        this.startNextStep();
      }
    } else {
      this.startNextStep();
    }
    this.sink.frame(dtMs, this.cameraPreset());
  }

  private settle(state: GameState): void {
    this.presentedState = state;
    pruneStackLinks(this.links, state);
    this.stepActive = false;
    this.pendingTarget = undefined;
  }

  private startNextStep(): void {
    if (this.queue.length === 0) { this.stepActive = false; return; }
    // Catch-up (§6.3): a deep backlog means we fell behind — snap through
    // everything but the newest state, then animate only that last leg.
    while (this.queue.length > DROP_THRESHOLD) this.applyStep(this.queue.shift()!, 0);
    const step = this.queue.shift()!;
    this.applyStep(step, this.durationFor(step, this.queue.length));
  }

  /** Push one step to the scene at `durationMs`; a 0 duration settles instantly. */
  private applyStep(step: Step, durationMs: number): void {
    accumulateStackLinks(this.links, step.events);
    this.reframe(step.state, durationMs);
    this.sink.applyTransition(step.state, this.presentedState, step.events, durationMs, this.links);
    if (durationMs > 0) {
      this.stepActive = true;
      this.stepElapsed = 0;
      this.stepDuration = durationMs;
      this.pendingTarget = step.state;
    } else {
      this.settle(step.state);
    }
  }

  /** Snap-vs-animate (§7.1) plus backlog scaling. Snap when there is nothing to
   *  animate *from* (first paint), across a game change, when the transition
   *  carries no events (the advisory-fallback = teleport), or under reduced
   *  motion. Otherwise ease, scaled down by the pending backlog. */
  private durationFor(step: Step, backlog: number): number {
    const from = this.presentedState;
    if (from === undefined || from.gameId !== step.state.gameId) return 0;
    if (step.events.length === 0 || this.reducedMotion) return 0;
    return Math.max(MIN_STEP_MS, Math.round(BASE_STEP_MS / (1 + backlog)));
  }

  // ── camera (design §7.3 — camera moves are the director's) ───────────────────

  private reframe(state: GameState, durationMs: number): void {
    const before = this.controller.view();
    this.controller.syncActive(seatOfPlayer(state, state.turn.activePlayerId));
    if (!sameView(before, this.controller.view())) this.moveCameraTo(this.controller.view(), durationMs);
  }

  /** Retarget the camera, tweening from its current interpolated preset. A 0
   *  duration (or reduced motion, or a game/first change) cuts. */
  private moveCameraTo(view: CameraView, durationMs: number): void {
    const to = camera(view, this.viewport, this.rightInset);
    if (durationMs <= 0 || this.reducedMotion) {
      this.camFrom = to; this.camTo = to; this.camDuration = 0; this.camElapsed = 0;
      return;
    }
    this.camFrom = this.cameraPreset();
    this.camTo = to;
    this.camDuration = durationMs;
    this.camElapsed = 0;
  }

  /** The camera preset the scene should apply this frame (interpolated). */
  cameraPreset(): CameraPreset {
    if (this.camDuration <= 0) return this.camTo;
    return lerpPreset(this.camFrom, this.camTo, ease(Math.min(1, this.camElapsed / this.camDuration)));
  }

  cameraView(): CameraView { return this.controller.view(); }
  isFollowing(): boolean { return this.controller.isFollowing(); }

  focusSeat(seat: number): void { this.controller.focus(seatView(seat)); this.moveCameraTo(this.controller.view(), CAMERA_MANUAL_MS); }
  showTable(): void { this.controller.focus(TABLE_VIEW); this.moveCameraTo(TABLE_VIEW, CAMERA_MANUAL_MS); }
  releaseCamera(): void { this.controller.release(); this.moveCameraTo(this.controller.view(), CAMERA_MANUAL_MS); }

  /** §14: pull back to the whole table if any named point is off-screen. */
  ensureVisible(points: Point[]): boolean {
    if (this.controller.ensureVisible(points, this.viewport, this.rightInset)) {
      this.moveCameraTo(TABLE_VIEW, CAMERA_MANUAL_MS);
      return true;
    }
    return false;
  }

  setViewport(size: Size): void {
    this.viewport = size;
    // A resize is not an animation — re-frame the current view as a cut.
    this.moveCameraTo(this.controller.view(), 0);
  }

  /** The log panel opened/closed/resized (§8): reserve its gutter so no seat frames
   *  under it. Re-frames as a cut, like a resize; ignored if unchanged. */
  setRightInset(px: number): void {
    const next = Math.max(0, Math.round(px));
    if (next === this.rightInset) return;
    this.rightInset = next;
    this.moveCameraTo(this.controller.view(), 0);
  }

  setReducedMotion(on: boolean): void { this.reducedMotion = on; }

  // ── §6.4 budgeted flush (wired to a this-seat prompt at T3) ──────────────────

  /** Compress remaining animation into `budgetMs`: snap through all but the
   *  newest queued state, then cap the last/in-flight step to the budget. The
   *  prompt dock never waits on this — it renders against authoritative state —
   *  but board affordances need the scene caught up, so this bounds the wait. */
  flush(budgetMs: number = DEFAULT_FLUSH_MS): void {
    if (this.queue.length > 0) {
      while (this.queue.length > 1) this.applyStep(this.queue.shift()!, 0);
      this.applyStep(this.queue.shift()!, Math.min(budgetMs, BASE_STEP_MS));
    } else if (this.stepActive) {
      this.stepDuration = Math.min(this.stepDuration, this.stepElapsed + budgetMs);
    }
  }

  // ── introspection (tests + the §12 harness) ──────────────────────────────────

  /** The real state the scene currently depicts (last settled). */
  get presented(): GameState | undefined { return this.presentedState; }

  /** The latest real state the core has handed us — the follow target. */
  get authoritative(): GameState | undefined {
    return this.queue.at(-1)?.state ?? this.pendingTarget ?? this.presentedState;
  }

  /** Pending states not yet presented (excludes the one currently animating). */
  get queueDepth(): number { return this.queue.length; }

  /** True when presented has caught up to authoritative and nothing is animating. */
  get settled(): boolean { return !this.stepActive && this.queue.length === 0; }
}

function sameView(a: CameraView, b: CameraView): boolean {
  return a.kind === 'table' ? b.kind === 'table' : b.kind === 'seat' && a.seat === b.seat;
}
