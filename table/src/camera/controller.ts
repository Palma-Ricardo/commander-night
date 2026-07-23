// The follow/override policy over the camera presets (design §7.3, §14). Pure
// state — no Pixi, no timers — so the whole policy is unit-tested headlessly; the
// scene reads `view()` each frame and applies `camera(view, viewport)`.
//
//  • Follows the active player by default, re-framing on turn change.
//  • A manual override (click a quadrant / compass / press 1–4) is **sticky**: the
//    camera never yanks itself away from something you chose to look at, until you
//    release it (Esc), which resumes follow.
//  • One — and only one — exception to stickiness: a prompt naming an object the
//    lens cannot see pulls back to the whole table (§14). Pulling back is always
//    safe; flying to a corner when the prompt spans several seats is not.

import type { Point, Size } from '../layout/types';
import { camera, rectVisible, seatView, TABLE_VIEW, type CameraView } from './camera';

export class CameraController {
  private current: CameraView = TABLE_VIEW;
  private following = true;
  private lastActiveSeat = -1;

  /** The view the scene should render this frame. */
  view(): CameraView {
    return this.current;
  }

  isFollowing(): boolean {
    return this.following;
  }

  /** A new active player (turn change). Re-frames only while following and only on
   *  an actual *change* from a previously-known active seat, so the initial load
   *  stays on the whole table until play moves — the whole quadrant world reads
   *  first, then the camera starts following (design §7.3: "re-frames on turn
   *  change"). Seat < 0 means unknown (e.g. the pre-game mulligan window). */
  syncActive(activeSeat: number): void {
    if (activeSeat < 0) return;
    const prev = this.lastActiveSeat;
    this.lastActiveSeat = activeSeat;
    if (prev >= 0 && prev !== activeSeat && this.following) this.current = seatView(activeSeat);
  }

  /** User override — pin a seat (or the whole table). Sticky until released. */
  focus(view: CameraView): void {
    this.following = false;
    this.current = view;
  }

  /** Esc — resume following; snap to whoever is active, else the whole table. */
  release(): void {
    this.following = true;
    this.current = this.lastActiveSeat >= 0 ? seatView(this.lastActiveSeat) : TABLE_VIEW;
  }

  /** §14: before a prompt becomes actionable, if any world point it concerns is
   *  off-screen under the current view, pull back to the whole table — the one
   *  preset that can never be wrong. Returns true if it moved the camera. */
  ensureVisible(points: Point[], viewport: Size): boolean {
    if (this.current.kind === 'table' || points.length === 0) return false;
    const preset = camera(this.current, viewport);
    // A point counts as visible only inside the safe area (above the hand band),
    // which rectVisible enforces for a zero-size rect at that point.
    const allVisible = points.every(p => rectVisible(preset, { x: p.x, y: p.y, w: 0, h: 0 }, viewport));
    if (allVisible) return false;
    this.current = TABLE_VIEW;
    return true;
  }
}

// Re-export the visibility helper for callers that frame against whole rects.
export { rectVisible };
