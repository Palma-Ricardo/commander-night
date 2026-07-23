// The camera (design §7.3): one transform over the fixed world container, driven
// by discrete presets only — the whole table, plus one per seat. There is no free
// pan or zoom: the user's problem is "show me that player", not navigation, so the
// presets interpolate predictably (T2) and unit-test trivially. All pure geometry
// here; the follow/override state machine is in controller.ts.
//
// Framing rules made concrete:
//  • The world is fitted into the viewport *above* the hand band, so every seat
//    lands clear of the hand at every window size (§13 exit criterion).
//  • A focused seat is framed against the middle of the table, not centred: its
//    outer (rail) corner is pinned to the safe-area corner, so the contested
//    centre and the neighbouring boards stay in shot (§7.3).
//  • The zoom stops short of filling the window, so neighbours bleed in at the
//    edges — that bleed is what proves it is one table (§7.3).
//
// Perspective (T4): the felt leans back like a real table. This is a genuine
// one-point projection about the table's horizontal centre-line — a *homography*,
// not the affine container squash the earlier code punted on (an affine squash
// keeps the felt a rectangle, which reads as flat). The warp is pure world-space
// (`warp`/`unwarp` below), a function of the preset's `tilt` alone; the preset's
// `scale`/`x`/`y` place the warped felt in the viewport afterwards. Because the
// warp is pre-scale, the framing math fits the *warped* bounds and pins the
// *warped* anchor, so the near (bottom) edge's perspective bulge never overflows
// the hand band. The render layer (CardActor / TableScene) rebuilds each card as a
// PerspectiveMesh from its four projected corners, so cards keystone with the felt.

import type { Point, Rect, Size } from '../layout/types';
import { handBandHeight } from '../layout/screen';
import { WORLD } from '../layout/world';

export type CameraView = { kind: 'table' } | { kind: 'seat'; seat: number };
export const TABLE_VIEW: CameraView = { kind: 'table' };
export const seatView = (seat: number): CameraView => ({ kind: 'seat', seat });

/** The world→screen transform plus the presentational tilt (§7.3). `scale`, `x`,
 *  `y` place the (already perspective-warped) world container; `tilt` is the lean
 *  angle of the felt, easing flatter as the lens comes in (~15° whole-table, 10°
 *  on a far seat, 6° on a near one — you look more steeply down at your own board).
 *  It rides through `lerpPreset` so a camera move interpolates it, and every
 *  projection (`worldToScreen`, `depthScaleAt`) reads it. */
export interface CameraPreset { x: number; y: number; scale: number; tilt: number }

const SAFE_MARGIN = 16;          // inset from the window edges
// The top-right compass HUD sits over the felt (styles.css: 162px wide, 12px in),
// anchored *left of* the log rail (`right: var(--rail-w) + 12px`), so it always
// overhangs the log gutter by a fixed amount into the felt — collapsed or open.
// Reserve that overhang on top of the log inset so the framing nudges left and the
// felt clears the compass in every log state (additive, not max: the compass never
// tucks inside the log — it rides just left of it).
const HUD_RIGHT_OVERHANG = 180;  // compass width + its margin + a small gap
const TABLE_FILL = 0.98;         // whole-table zoom leaves a thin rail
const SEAT_FILL = 0.98;
// How far a seat view reaches past the felt centre (world px). The framing is
// height-limited, so BLEED_Y sets the zoom: it must be small enough that a seat
// fills the frame — otherwise a re-frame barely changes the picture and follow
// reads as "nothing moved", with neighbouring seats indistinguishable (reviewed
// 2026-07-23). BLEED_X stays generous (it never limits the fit) so the contested
// centre and the horizontal neighbour still bleed in. Net seat zoom ≈ 1.7× the
// whole-table view, under the ~2× ceiling where the whole quadrant stops fitting.
const BLEED_X = 380;
const BLEED_Y = 120;
const TILT_TABLE = 15 * Math.PI / 180;
const TILT_SEAT_FAR = 10 * Math.PI / 180;   // the two far seats (top row)
const TILT_SEAT_NEAR = 6 * Math.PI / 180;   // your seat + its neighbour (bottom row)
// Eye distance for the perspective divide, in world px. Larger ⇒ gentler tilt.
// Tuned at the table (docs: T4 is reviewed by screenshot, not by assertion); this
// mirrors the mockup's `perspective: 1500px` in the world's own units.
const PERSP_D = 1500;

// ── the perspective warp (T4) ─────────────────────────────────────────────────

const TABLE_CX = WORLD.w / 2;
const TABLE_CY = WORLD.h / 2;

/** Warp a world point about the table's horizontal centre-line by `tilt`, in pure
 *  world units. `tilt > 0` leans the far (top, small-y) edge away, so it recedes
 *  (`f < 1`, converging inward and foreshortened); the near (bottom) edge
 *  approaches (`f > 1`). `f` is the depth scale a card at that point renders at. */
function warp(tilt: number, p: Point): { x: number; y: number; f: number } {
  if (tilt === 0) return { x: p.x, y: p.y, f: 1 };
  const dx = p.x - TABLE_CX;
  const dy = p.y - TABLE_CY;
  const z = dy * Math.sin(tilt);
  const f = PERSP_D / (PERSP_D - z);
  return { x: TABLE_CX + dx * f, y: TABLE_CY + dy * Math.cos(tilt) * f, f };
}

/** Inverse of `warp` — recover the world point from its warped position. Closed
 *  form (the warp is a homography), so `unwarp ∘ warp` is exact to float error. */
function unwarp(tilt: number, q: Point): Point {
  if (tilt === 0) return { x: q.x, y: q.y };
  const sx = q.x - TABLE_CX;
  const sy = q.y - TABLE_CY;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const dy = (sy * PERSP_D) / (cos * PERSP_D + sy * sin);
  const f = PERSP_D / (PERSP_D - dy * sin);
  return { x: TABLE_CX + sx / f, y: TABLE_CY + dy };
}

/** The axis-aligned bounds of `rect` after the warp. The warp maps a rectangle's
 *  four corners to the bounding extremes (x-extremes on the near/bottom edge,
 *  y-extremes on the top/bottom edges — both monotonic in y), so the corners
 *  suffice: no need to sample the interior. */
function warpedBounds(rect: Rect, tilt: number): Rect {
  const cs = [
    warp(tilt, { x: rect.x, y: rect.y }),
    warp(tilt, { x: rect.x + rect.w, y: rect.y }),
    warp(tilt, { x: rect.x + rect.w, y: rect.y + rect.h }),
    warp(tilt, { x: rect.x, y: rect.y + rect.h }),
  ];
  const xs = cs.map(c => c.x);
  const ys = cs.map(c => c.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The region the world is framed into: the viewport minus the hand band, a
 *  uniform margin, and `rightInset` — the width the log panel steals from the
 *  right when it is open (§8). Framing into the space *left of* the log is what
 *  keeps a right-seat's pile column out from under it (the mockup sits the felt
 *  and the log side by side); a collapsed log reports 0 and the felt spreads back. */
export function safeArea(viewport: Size, rightInset = 0): Rect {
  const band = handBandHeight(viewport);
  const reserve = Math.max(0, rightInset) + HUD_RIGHT_OVERHANG;   // log gutter + the compass that overhangs it
  return {
    x: SAFE_MARGIN,
    y: SAFE_MARGIN,
    w: Math.max(1, viewport.w - 2 * SAFE_MARGIN - reserve),
    h: Math.max(1, viewport.h - band - SAFE_MARGIN),
  };
}

// Seat corner in world coords (mirrors CORNER_BY_DISPLAY in world.ts). Display 0
// is bottom-left; 1 bottom-right; 2 top-right; 3 top-left.
function seatCorner(seat: number): { left: boolean; bottom: boolean } {
  switch (((seat % 4) + 4) % 4) {
    case 0: return { left: true, bottom: true };
    case 1: return { left: false, bottom: true };
    case 2: return { left: false, bottom: false };
    default: return { left: true, bottom: false };
  }
}

/** The lean angle for a seat view: the near (bottom) seats you look down at more
 *  steeply, so they tilt less than the far ones (matches the §7.2 mockup). */
function seatTilt(seat: number): number {
  return seatCorner(seat).bottom ? TILT_SEAT_NEAR : TILT_SEAT_FAR;
}

/** The world rectangle a seat view frames: from the seat's outer corner to a
 *  point past the felt centre, so the whole quadrant plus the contested middle
 *  and a strip of neighbours are inside it. */
export function seatFocusRect(seat: number): Rect {
  const c = seatCorner(seat);
  const outerX = c.left ? 0 : WORLD.w;
  const outerY = c.bottom ? WORLD.h : 0;
  const innerX = c.left ? WORLD.w / 2 + BLEED_X : WORLD.w / 2 - BLEED_X;
  const innerY = c.bottom ? WORLD.h / 2 - BLEED_Y : WORLD.h / 2 + BLEED_Y;
  return {
    x: Math.min(outerX, innerX),
    y: Math.min(outerY, innerY),
    w: Math.abs(innerX - outerX),
    h: Math.abs(innerY - outerY),
  };
}

/** The preset for a view at a viewport — the whole camera rig's core (design §7.3).
 *  `rightInset` reserves the open log's gutter so nothing frames under it (§8). The
 *  fit is against the *warped* bounds and the pin is on the *warped* anchor, so the
 *  perspective bulge of the near edge stays inside the safe area (T4). */
export function camera(view: CameraView, viewport: Size, rightInset = 0): CameraPreset {
  const area = safeArea(viewport, rightInset);
  if (view.kind === 'table') {
    // Whole world, warped, centred in the safe area.
    const b = warpedBounds({ x: 0, y: 0, w: WORLD.w, h: WORLD.h }, TILT_TABLE);
    const scale = Math.min(area.w / b.w, area.h / b.h) * TABLE_FILL;
    return {
      scale,
      x: area.x + (area.w - b.w * scale) / 2 - b.x * scale,
      y: area.y + (area.h - b.h * scale) / 2 - b.y * scale,
      tilt: TILT_TABLE,
    };
  }

  const c = seatCorner(view.seat);
  const tilt = seatTilt(view.seat);
  const focus = seatFocusRect(view.seat);
  const b = warpedBounds(focus, tilt);
  const scale = Math.min(area.w / b.w, area.h / b.h) * SEAT_FILL;
  // Sit the warped focus flush against the seat's outer side of the safe area, so
  // the seat hugs the window edge and the centre opens toward the middle (§7.3).
  // For a near (bottom) seat the outer corner *is* the warped extreme, so this
  // reduces to pinning that corner exactly; for a far (top) seat the near edge
  // magnifies past the receded outer corner, so flushing the bounds (not the raw
  // corner) is what keeps that bulge inside the frame — the outer corner then sits
  // slightly inset, which is the correct perspective recession.
  return {
    scale,
    x: c.left ? area.x - b.x * scale : area.x + area.w - (b.x + b.w) * scale,
    y: c.bottom ? area.y + area.h - (b.y + b.h) * scale : area.y - b.y * scale,
    tilt,
  };
}

/** Linear blend of two presets — the director tweens camera moves through this
 *  (§7.3: camera moves are the director's, so they interpolate like any other).
 *  tilt eases along with the rest, so the felt flattens as a seat comes in. */
export function lerpPreset(a: CameraPreset, b: CameraPreset, t: number): CameraPreset {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    scale: a.scale + (b.scale - a.scale) * t,
    tilt: a.tilt + (b.tilt - a.tilt) * t,
  };
}

// ── projection ───────────────────────────────────────────────────────────────

/** World point → screen point through the full camera: warp about the table's
 *  centre-line, then place by the preset's scale/offset. */
export function worldToScreen(preset: CameraPreset, p: Point): Point {
  const w = warp(preset.tilt, p);
  return { x: w.x * preset.scale + preset.x, y: w.y * preset.scale + preset.y };
}

/** Screen point → world point — the exact inverse of `worldToScreen`. */
export function screenToWorld(preset: CameraPreset, p: Point): Point {
  return unwarp(preset.tilt, { x: (p.x - preset.x) / preset.scale, y: (p.y - preset.y) / preset.scale });
}

/** The extra size factor a card at world point `p` renders at, from the
 *  perspective divide alone (1 at the tilt axis, <1 far, >1 near). Multiply into
 *  `preset.scale` for the on-screen card size; the render layer uses it to size
 *  chrome and hover anchors that don't go through a full four-corner projection. */
export function depthScaleAt(preset: CameraPreset, p: Point): number {
  return warp(preset.tilt, p).f;
}

/** Does the whole world rect `r` project inside the viewport (and above the hand)?
 *  Used to assert framing and to decide the §14 pull-back when a prompt names an
 *  object the lens cannot see. Projects all four corners — under perspective the
 *  bounding extremes are at the (magnified) near corners, not tl/br alone. */
export function rectVisible(preset: CameraPreset, r: Rect, viewport: Size, rightInset = 0): boolean {
  const band = handBandHeight(viewport);
  const cs = [
    worldToScreen(preset, { x: r.x, y: r.y }),
    worldToScreen(preset, { x: r.x + r.w, y: r.y }),
    worldToScreen(preset, { x: r.x + r.w, y: r.y + r.h }),
    worldToScreen(preset, { x: r.x, y: r.y + r.h }),
  ];
  const minX = Math.min(...cs.map(c => c.x));
  const maxX = Math.max(...cs.map(c => c.x));
  const minY = Math.min(...cs.map(c => c.y));
  const maxY = Math.max(...cs.map(c => c.y));
  return minX >= 0 && minY >= 0 && maxX <= viewport.w - Math.max(0, rightInset) && maxY <= viewport.h - band;
}
