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
//    safe; flying to a corner when the prompt spans several seats is not. That
//    pull-back is **transient** — it releases itself the moment the object is back
//    in shot (or the prompt clears), restoring the pin (or the followed seat) you
//    were on. There is no saved state to leak: it is recomputed from the intended
//    view on every `keepVisible`, so it can never outlive its reason.

import type { Point, Size } from '../layout/types';
import { camera, rectVisible, seatView, TABLE_VIEW, type CameraView } from './camera';

export class CameraController {
  // The view the follow/pin policy *wants* — moved by syncActive (follow) and focus
  // (manual pin). What we render can differ from it only while a §14 pull-back holds
  // the whole table; `view()` folds the two together.
  private intent: CameraView = TABLE_VIEW;
  private following = true;
  private lastActiveSeat = -1;
  // §14: a prompt references something the intended view can't show, so we hold the
  // whole table until it can. Recomputed from scratch on every keepVisible (no saved
  // view), so releasing it always lands back on `intent` — the pin or followed seat.
  private pulledBack = false;
  // Combat is on the board (attackers declared): the whole table reads best, so while
  // *following* we frame it there — attacks span the table, and the arrows want room.
  // A manual pin still wins (it's your explicit pick); combat is a follow-time default,
  // not an override. Cleared when combat leaves the board → back to the followed seat.
  private combat = false;

  /** The view the scene should render this frame — the intended view, unless a §14
   *  pull-back or live combat is holding the whole table. */
  view(): CameraView {
    return this.pulledBack ? TABLE_VIEW : this.effectiveIntent();
  }

  /** The view follow/pin wants, folding in the combat default: the whole table while
   *  following during combat, otherwise the pinned/followed seat. The §14 pull-back
   *  sits on top of this in `view()`. */
  private effectiveIntent(): CameraView {
    return this.following && this.combat ? TABLE_VIEW : this.intent;
  }

  isFollowing(): boolean {
    return this.following;
  }

  /** A new active player (turn change). Re-frames only while following and only on
   *  an actual *change* from a previously-known active seat, so the initial load
   *  stays on the whole table until play moves — the whole quadrant world reads
   *  first, then the camera starts following (design §7.3: "re-frames on turn
   *  change"). Seat < 0 means unknown (e.g. the pre-game mulligan window). Moves the
   *  *intended* view even while a pull-back holds the table, so releasing the
   *  pull-back lands on whoever is active now, not a stale seat. */
  syncActive(activeSeat: number): void {
    if (activeSeat < 0) return;
    const prev = this.lastActiveSeat;
    this.lastActiveSeat = activeSeat;
    if (prev >= 0 && prev !== activeSeat && this.following) this.intent = seatView(activeSeat);
  }

  /** Combat entered/left the board. While following, live combat frames the whole
   *  table (attacks span it); when it clears we fall back to the followed seat. A
   *  manual pin is untouched — combat is a follow-time default, not an override. */
  setCombat(active: boolean): void {
    this.combat = active;
  }

  /** User override — pin a seat (or the whole table). Sticky until released, and it
   *  cancels any transient pull-back: an explicit pick is what you want to see. */
  focus(view: CameraView): void {
    this.following = false;
    this.intent = view;
    this.pulledBack = false;
  }

  /** Esc — resume following; snap to whoever is active, else the whole table. */
  release(): void {
    this.following = true;
    this.intent = this.lastActiveSeat >= 0 ? seatView(this.lastActiveSeat) : TABLE_VIEW;
    this.pulledBack = false;
  }

  /** §14: keep the world points a prompt names in shot. Pull back to the whole table
   *  while any would be off-screen under the intended view; drop the pull-back — back
   *  to the pin or the followed seat — the moment they're all visible again, or there
   *  are none (the prompt cleared, the spell resolved off the stack). Idempotent:
   *  recomputed each call, so it never sticks on the table after its reason is gone.
   *  Returns true if the *rendered* view changed. */
  keepVisible(points: Point[], viewport: Size, rightInset = 0): boolean {
    const before = this.view();
    this.pulledBack = !this.intentShows(points, viewport, rightInset);
    return !sameView(before, this.view());
  }

  /** Whether the effective view (pin/followed seat, or the whole table during
   *  combat) frames every point inside the safe area (above the hand band, clear of
   *  the open log). The whole table shows everything by construction, and an empty
   *  point set has nothing to hide. */
  private intentShows(points: Point[], viewport: Size, rightInset: number): boolean {
    const base = this.effectiveIntent();
    if (base.kind === 'table' || points.length === 0) return true;
    const preset = camera(base, viewport, rightInset);
    return points.every(p => rectVisible(preset, { x: p.x, y: p.y, w: 0, h: 0 }, viewport, rightInset));
  }
}

function sameView(a: CameraView, b: CameraView): boolean {
  return a.kind === 'table' ? b.kind === 'table' : b.kind === 'seat' && a.seat === b.seat;
}

// Re-export the visibility helper for callers that frame against whole rects.
export { rectVisible };
