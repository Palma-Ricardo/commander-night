import { describe, expect, it } from 'vitest';
import {
  camera, rectVisible, safeArea, seatFocusRect, seatView, TABLE_VIEW, worldToScreen, screenToWorld,
  HUD_RIGHT_OVERHANG,
} from '../src/camera/camera';
import { CameraController } from '../src/camera/controller';
import { seatQuadrantRect, WORLD } from '../src/layout/world';
import { handBandHeight } from '../src/layout/screen';
import { SUPPORTED_VIEWPORTS } from './helpers';

const WORLD_RECT = { x: 0, y: 0, w: WORLD.w, h: WORLD.h };

describe('camera framing', () => {
  it('table view fits the whole felt clear of the hand at every window size', () => {
    for (const vp of SUPPORTED_VIEWPORTS) {
      const preset = camera(TABLE_VIEW, vp);
      expect(rectVisible(preset, WORLD_RECT, vp)).toBe(true);
    }
  });

  it('EXIT CRITERION: every seat preset frames that seat fully in view and clear of the hand', () => {
    for (const vp of SUPPORTED_VIEWPORTS) {
      for (let seat = 0; seat < 4; seat++) {
        const preset = camera(seatView(seat), vp);
        const quad = seatQuadrantRect(seat);
        expect(rectVisible(preset, quad, vp), `seat ${seat} @ ${vp.w}x${vp.h}`).toBe(true);
        // and strictly above the hand band (clear, not merely inside the window)
        const bottom = worldToScreen(preset, { x: quad.x, y: quad.y + quad.h });
        expect(bottom.y).toBeLessThanOrEqual(vp.h - handBandHeight(vp) + 0.001);
      }
    }
  });

  it('frames a focused seat against the middle: the outer side sits flush to the safe area', () => {
    const vp = { w: 1920, h: 1080 };
    const area = safeArea(vp);
    // display 0 = bottom-left, a NEAR seat → its outer corner (0, H) is the warped
    // extreme, so it pins exactly to the safe-area bottom-left corner.
    const p0 = camera(seatView(0), vp);
    const bl = worldToScreen(p0, { x: 0, y: WORLD.h });
    expect(bl.x).toBeCloseTo(area.x, 3);
    expect(bl.y).toBeCloseTo(area.y + area.h, 3);
    // display 2 = top-right, a FAR seat → the top edge is flush to the area top
    // (its y still pins exactly), but the receded outer corner (W, 0) insets from
    // the right under perspective — the seat's near edge is the widest point, so
    // *that* is what sits flush to the area's right side.
    // display 2 is right-column, so it insets from the right by the compass reserve.
    const area2 = safeArea(vp, HUD_RIGHT_OVERHANG);
    const p2 = camera(seatView(2), vp);
    const tr = worldToScreen(p2, { x: WORLD.w, y: 0 });
    expect(tr.y).toBeCloseTo(area2.y, 3);
    expect(tr.x).toBeLessThanOrEqual(area2.x + area2.w + 1e-6);
    const focus2 = seatFocusRect(2);
    const flush = worldToScreen(p2, { x: focus2.x + focus2.w, y: focus2.y + focus2.h });
    expect(flush.x).toBeCloseTo(area2.x + area2.w, 3);
  });

  it('reserves the compass for right seats only — the whole-table view stays centred', () => {
    const vp = { w: 1920, h: 1080 };
    const a = safeArea(vp);
    // Whole table: the warped world sits with equal gaps left and right of the safe
    // area — no compass shove (that reserve is scoped to right-column seats).
    const pt = camera(TABLE_VIEW, vp);
    const xs = [[0, 0], [WORLD.w, 0], [WORLD.w, WORLD.h], [0, WORLD.h]]
      .map(([x, y]) => worldToScreen(pt, { x: x!, y: y! }).x);
    expect(Math.min(...xs) - a.x).toBeCloseTo(a.x + a.w - Math.max(...xs), 1);
    // A right-column seat (display 3, bottom-right under the clockwise §7.2 order)
    // frames a compass-overhang short of the full width, so its pile column clears
    // the HUD.
    const p3 = camera(seatView(3), vp);
    const outer3 = worldToScreen(p3, { x: WORLD.w, y: WORLD.h }).x;
    expect(outer3).toBeLessThan(a.x + a.w - HUD_RIGHT_OVERHANG + 1);
  });

  it('leaves neighbours bleeding in — a seat never fills the window', () => {
    for (const vp of SUPPORTED_VIEWPORTS) {
      const preset = camera(seatView(1), vp);
      const quad = seatQuadrantRect(1);
      const w = quad.w * preset.scale;
      expect(w).toBeLessThan(vp.w);      // room on the sides for the next board
    }
  });

  it('zooms in on a seat relative to the whole table', () => {
    const vp = { w: 1920, h: 1080 };
    expect(camera(seatView(0), vp).scale).toBeGreaterThan(camera(TABLE_VIEW, vp).scale);
  });

  it('zooms in HARD enough that following reads as a move (≥1.6× the table)', () => {
    // A gentle seat zoom makes a re-frame look like nothing happened and leaves
    // opposite seats indistinguishable (reviewed 2026-07-23). Assert a real jump
    // at every supported window size, for every seat.
    for (const vp of SUPPORTED_VIEWPORTS) {
      const table = camera(TABLE_VIEW, vp).scale;
      for (let seat = 0; seat < 4; seat++) {
        const ratio = camera(seatView(seat), vp).scale / table;
        expect(ratio, `seat ${seat} @ ${vp.w}x${vp.h}`).toBeGreaterThan(1.6);
      }
    }
  });
});

describe('projection round-trip', () => {
  it('screenToWorld ∘ worldToScreen is identity for every preset', () => {
    const views = [TABLE_VIEW, seatView(0), seatView(1), seatView(2), seatView(3)];
    const pts = [{ x: 0, y: 0 }, { x: 1200, y: 760 }, { x: 2400, y: 1520 }, { x: 137, y: 902 }];
    for (const vp of SUPPORTED_VIEWPORTS) {
      for (const v of views) {
        const preset = camera(v, vp);
        for (const p of pts) {
          const back = screenToWorld(preset, worldToScreen(preset, p));
          expect(back.x).toBeCloseTo(p.x, 6);
          expect(back.y).toBeCloseTo(p.y, 6);
        }
      }
    }
  });
});

describe('seat order (§7.2: you bottom-left, turn order clockwise)', () => {
  // Two corner tables exist — CORNER_BY_DISPLAY (world.ts) places the cards, and
  // seatCorner (camera.ts) frames them. They must agree, and both must run
  // clockwise; they disagreed with the spec until 2026-07-30 (Issues.txt #17).
  it('walks the quadrants clockwise on screen from bottom-left', () => {
    const centres = [0, 1, 2, 3].map(seat => {
      const q = seatQuadrantRect(seat);
      return { x: q.x + q.w / 2, y: q.y + q.h / 2 };
    });
    const [you, next, across, last] = centres as [typeof centres[0], typeof centres[0], typeof centres[0], typeof centres[0]];
    expect(you.x).toBeLessThan(WORLD.w / 2);        // bottom-left
    expect(you.y).toBeGreaterThan(WORLD.h / 2);
    expect(next.x).toBeLessThan(WORLD.w / 2);       // top-left — up the left side
    expect(next.y).toBeLessThan(WORLD.h / 2);
    expect(across.x).toBeGreaterThan(WORLD.w / 2);  // top-right — across the top
    expect(across.y).toBeLessThan(WORLD.h / 2);
    expect(last.x).toBeGreaterThan(WORLD.w / 2);    // bottom-right — down the right
    expect(last.y).toBeGreaterThan(WORLD.h / 2);
    // Signed (shoelace) area of the seat polygon. The y-axis points down on screen,
    // which flips the usual convention: positive = clockwise as seen by the player.
    const area = centres.reduce((sum, p, i) => {
      const q = centres[(i + 1) % centres.length]!;
      return sum + (p.x * q.y - q.x * p.y);
    }, 0);
    expect(area).toBeGreaterThan(0);
  });

  it('the camera frames each seat over its own quadrant', () => {
    for (const seat of [0, 1, 2, 3]) {
      const q = seatQuadrantRect(seat);
      const f = seatFocusRect(seat);
      // The focus rect starts at the seat's own outer corner and reaches past the
      // felt centre, so the quadrant's outer corner is inside it.
      const cx = q.x + q.w / 2;
      const cy = q.y + q.h / 2;
      expect(cx).toBeGreaterThanOrEqual(f.x);
      expect(cx).toBeLessThanOrEqual(f.x + f.w);
      expect(cy).toBeGreaterThanOrEqual(f.y);
      expect(cy).toBeLessThanOrEqual(f.y + f.h);
    }
  });
});

describe('CameraController follow / override policy', () => {
  it('starts on your own seat (the mulligan window has no turn structure), following', () => {
    const c = new CameraController();
    expect(c.view()).toEqual(seatView(0));
    expect(c.isFollowing()).toBe(true);
  });

  it('follows the FIRST active player it ever sees — the opening turn (#6)', () => {
    const c = new CameraController();
    c.syncActive(2);                       // first sighting: mulligans done, turn 1 begins
    expect(c.view()).toEqual(seatView(2));
    c.syncActive(2);                       // same seat → no-op
    expect(c.view()).toEqual(seatView(2));
    c.syncActive(3);                       // a later turn change → follow
    expect(c.view()).toEqual(seatView(3));
  });

  it('ignores an unknown active seat (mulligan window)', () => {
    const c = new CameraController();
    c.syncActive(1);
    c.syncActive(-1);                      // unknown → no change to baseline
    c.syncActive(3);
    expect(c.view()).toEqual(seatView(3));
  });

  it('a manual override is sticky against follow until released', () => {
    const c = new CameraController();
    c.syncActive(0);
    c.syncActive(1);                       // following → seat 1
    c.focus(seatView(3));                  // user pins seat 3
    expect(c.isFollowing()).toBe(false);
    c.syncActive(2);                       // turn moves — camera stays pinned
    expect(c.view()).toEqual(seatView(3));
    c.release();                           // Esc → resume follow, snap to active
    expect(c.isFollowing()).toBe(true);
    expect(c.view()).toEqual(seatView(2));
  });

  it('combat frames the whole table while following, then falls back to the seat', () => {
    const c = new CameraController();
    c.syncActive(0);
    c.syncActive(2);                       // following seat 2
    expect(c.view()).toEqual(seatView(2));
    c.setCombat(true);                     // attacks on the board → whole table
    expect(c.view()).toEqual(TABLE_VIEW);
    expect(c.isFollowing()).toBe(true);    // still following underneath
    c.setCombat(false);                    // combat clears → back to the followed seat
    expect(c.view()).toEqual(seatView(2));
  });

  it('a manual pin wins over the combat default (combat is a follow-time default)', () => {
    const c = new CameraController();
    c.syncActive(0);
    c.syncActive(1);
    c.setCombat(true);
    c.focus(seatView(3));                  // user pins during combat
    expect(c.view()).toEqual(seatView(3));  // pin holds, combat does not override it
    c.release();                           // Esc while combat is still live → table
    expect(c.view()).toEqual(TABLE_VIEW);
  });

  it('§14: a prompt naming an off-screen object pulls back to the whole table', () => {
    const vp = { w: 1920, h: 1080 };
    const c = new CameraController();
    c.focus(seatView(0));                  // pinned bottom-left
    // a point deep in the opposite (top-right) quadrant is off-screen here
    const moved = c.keepVisible([{ x: 2200, y: 200 }], vp);
    expect(moved).toBe(true);
    expect(c.view()).toEqual(TABLE_VIEW);
  });

  it('§14: does not move when the named object is already visible', () => {
    const vp = { w: 1920, h: 1080 };
    const c = new CameraController();
    c.focus(seatView(0));
    const moved = c.keepVisible([{ x: 120, y: 1400 }], vp);  // inside the focused quadrant
    expect(moved).toBe(false);
    expect(c.view()).toEqual(seatView(0));
  });

  it('§14: the pull-back is transient — it restores the manual pin once the object returns', () => {
    const vp = { w: 1920, h: 1080 };
    const c = new CameraController();
    c.focus(seatView(0));                  // pinned bottom-left
    c.keepVisible([{ x: 2200, y: 200 }], vp);            // off-screen → table
    expect(c.view()).toEqual(TABLE_VIEW);
    const moved = c.keepVisible([], vp);                 // prompt cleared → restore the pin
    expect(moved).toBe(true);
    expect(c.view()).toEqual(seatView(0));
    expect(c.isFollowing()).toBe(false);
  });

  it('§14: a pull-back while following restores to whoever is active now, not a stale seat', () => {
    const vp = { w: 1920, h: 1080 };
    const c = new CameraController();
    c.syncActive(0);
    c.syncActive(1);                       // following seat 1 (top-left)
    c.keepVisible([{ x: WORLD.w - 200, y: WORLD.h - 200 }], vp);   // far bottom-right → off-screen → table
    expect(c.view()).toEqual(TABLE_VIEW);
    c.syncActive(2);                       // turn advances under the pull-back
    c.keepVisible([], vp);                 // released → follows the *new* active seat
    expect(c.view()).toEqual(seatView(2));
    expect(c.isFollowing()).toBe(true);
  });

  it('§14: an explicit pick cancels a pull-back rather than snapping back to it', () => {
    const vp = { w: 1920, h: 1080 };
    const c = new CameraController();
    c.focus(seatView(0));                  // pinned bottom-left
    c.keepVisible([{ x: 200, y: 200 }], vp);            // far top-left → table
    c.focus(seatView(2));                  // user pins top-right mid-pull-back
    expect(c.view()).toEqual(seatView(2));
    c.keepVisible([{ x: 200, y: 200 }], vp);            // still off-screen from seat 2 → table again
    expect(c.view()).toEqual(TABLE_VIEW);
    c.keepVisible([], vp);                 // clears → back to the seat the user picked
    expect(c.view()).toEqual(seatView(2));
  });
});
