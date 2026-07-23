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

import type { Point, Rect, Size } from '../layout/types';
import { handBandHeight } from '../layout/screen';
import { WORLD } from '../layout/world';

export type CameraView = { kind: 'table' } | { kind: 'seat'; seat: number };
export const TABLE_VIEW: CameraView = { kind: 'table' };
export const seatView = (seat: number): CameraView => ({ kind: 'seat', seat });

/** The world→screen transform plus the presentational tilt (§7.3). `scale`, `x`,
 *  `y` place the world container; `tilt` eases flatter as the lens comes in (~15°
 *  whole-table, ~8° on a seat) and is meant to lean the felt back like a real
 *  table. It rides through `lerpPreset` so a camera move interpolates it, but the
 *  renderer does not yet consume it: an affine container squash distorts the cards
 *  without reading as tilt (a symmetric felt carries no perspective cue), so a real
 *  perspective projection is the pending fix (T4). */
export interface CameraPreset { x: number; y: number; scale: number; tilt: number }

const SAFE_MARGIN = 16;          // inset from the window edges
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
const TILT_SEAT = 8 * Math.PI / 180;

/** The region the world is framed into: the viewport minus the hand band and a
 *  uniform margin. Everything the camera fits lands here. */
export function safeArea(viewport: Size): Rect {
  const band = handBandHeight(viewport);
  return {
    x: SAFE_MARGIN,
    y: SAFE_MARGIN,
    w: Math.max(1, viewport.w - 2 * SAFE_MARGIN),
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

/** Fit `focus` into `area`, then pin `focusAnchor` (a world point on `focus`) to
 *  `areaAnchor` (a screen point on `area`) so the framing biases as intended. */
function frame(focus: Rect, area: Rect, fill: number, focusAnchor: Point, areaAnchor: Point): CameraPreset {
  const scale = Math.min(area.w / focus.w, area.h / focus.h) * fill;
  return {
    scale,
    x: areaAnchor.x - focusAnchor.x * scale,
    y: areaAnchor.y - focusAnchor.y * scale,
    tilt: 0,
  };
}

/** The preset for a view at a viewport — the whole camera rig's core (design §7.3). */
export function camera(view: CameraView, viewport: Size): CameraPreset {
  const area = safeArea(viewport);
  if (view.kind === 'table') {
    // Whole world, centred in the safe area.
    const focus: Rect = { x: 0, y: 0, w: WORLD.w, h: WORLD.h };
    const scale = Math.min(area.w / focus.w, area.h / focus.h) * TABLE_FILL;
    return {
      scale,
      x: area.x + (area.w - focus.w * scale) / 2,
      y: area.y + (area.h - focus.h * scale) / 2,
      tilt: TILT_TABLE,
    };
  }

  const c = seatCorner(view.seat);
  const focus = seatFocusRect(view.seat);
  // Pin the seat's outer world corner to the matching corner of the safe area, so
  // the seat sits at the window edge and the centre opens up toward the middle.
  const focusAnchor: Point = { x: c.left ? 0 : WORLD.w, y: c.bottom ? WORLD.h : 0 };
  const areaAnchor: Point = {
    x: c.left ? area.x : area.x + area.w,
    y: c.bottom ? area.y + area.h : area.y,
  };
  const preset = frame(focus, area, SEAT_FILL, focusAnchor, areaAnchor);
  preset.tilt = TILT_SEAT;
  return preset;
}

/** Linear blend of two presets — the director tweens camera moves through this
 *  (§7.3: camera moves are the director's, so they interpolate like any other).
 *  tilt rides along for T4's perspective; projection ignores it. */
export function lerpPreset(a: CameraPreset, b: CameraPreset, t: number): CameraPreset {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    scale: a.scale + (b.scale - a.scale) * t,
    tilt: a.tilt + (b.tilt - a.tilt) * t,
  };
}

// ── projection ───────────────────────────────────────────────────────────────

export function worldToScreen(preset: CameraPreset, p: Point): Point {
  return { x: p.x * preset.scale + preset.x, y: p.y * preset.scale + preset.y };
}

export function screenToWorld(preset: CameraPreset, p: Point): Point {
  return { x: (p.x - preset.x) / preset.scale, y: (p.y - preset.y) / preset.scale };
}

/** Does the whole world rect `r` project inside the viewport (and above the hand)?
 *  Used to assert framing and to decide the §14 pull-back when a prompt names an
 *  object the lens cannot see. */
export function rectVisible(preset: CameraPreset, r: Rect, viewport: Size): boolean {
  const band = handBandHeight(viewport);
  const tl = worldToScreen(preset, { x: r.x, y: r.y });
  const br = worldToScreen(preset, { x: r.x + r.w, y: r.y + r.h });
  return tl.x >= 0 && tl.y >= 0 && br.x <= viewport.w && br.y <= viewport.h - band;
}
