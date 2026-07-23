// The Pixi-free half of table interaction (design §7/§10). Kept out of TableScene
// — which imports pixi.js and so cannot load in the vitest node env — so the
// affordance→highlight mapping, the quadrant hit-test, and the world→screen
// anchor projection are all unit-testable headlessly, exactly as the T2 director
// keeps its clock Pixi-free. TableScene composes these with live actors + camera.

import type { Affordance } from '@night/core/state/selectors';
import { worldToScreen, type CameraPreset } from '../camera/camera';
import type { ActorSpace, Point, Rect } from '../layout/types';

/** An affordance highlight the scene paints on an interactive actor (§7): a
 *  coloured ring, plus a selected fill for a chosen target. Pixi-free. */
export interface HighlightSpec { color: number; selected?: boolean; dim?: boolean }

/** A screen-space anchor rect (§9), structurally the chrome hover store's
 *  HoverAnchor — kept here so the scene never imports the React chrome. */
export interface ScreenAnchor { left: number; top: number; width: number; height: number }

// Highlight ring colours (§7), mirroring the classic client's CSS
// (--in / --accent / --out / --error).
export const HL_ACTION = 0x9ece6a;
export const HL_TARGET = 0x7aa2f7;
export const HL_SOURCE = 0xe0af68;
export const HL_COMBAT = 0xf7768e;

const CARD_NATIVE = { w: 200, h: 280 } as const;   // native table-tier px (world.ts CARD_TEX)

/** The ring an affordance paints on the felt. Undefined ⇒ no highlight — either
 *  no affordance, or manaOnly, which is never a click target (context menu only,
 *  a T4 item), matching the classic client. */
export function highlightForAffordance(aff: Affordance | undefined): HighlightSpec | undefined {
  if (aff === undefined) return undefined;
  switch (aff.kind) {
    case 'action': return { color: HL_ACTION };
    case 'target': return { color: HL_TARGET, selected: aff.selected };
    case 'source': return { color: HL_SOURCE, dim: aff.cantPay };
    case 'combatCandidate': return { color: HL_COMBAT };
    case 'combatDeclared': return { color: HL_COMBAT, selected: true };
    case 'manaOnly': return undefined;
  }
}

/** Whether a click on the actor does anything (drives the cursor). Mirrors
 *  interact.objectClick: manaOnly is never a click target. */
export function isClickable(aff: Affordance | undefined): boolean {
  return aff !== undefined && aff.kind !== 'manaOnly';
}

export function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
}

/** The on-screen rect of a card actor, for anchoring a DOM hover preview (§10
 *  sceneToScreen). World actors project through the live camera; the screen-space
 *  hand does not. `pos` is the actor's current (animated) position, `scale` its
 *  placement scale relative to the native 200×280 face. */
export function screenAnchor(space: ActorSpace, pos: Point, scale: number, preset: CameraPreset): ScreenAnchor {
  const world = space === 'world';
  const s = world ? scale * preset.scale : scale;
  const c = world ? worldToScreen(preset, pos) : pos;
  const w = CARD_NATIVE.w * s;
  const h = CARD_NATIVE.h * s;
  return { left: c.x - w / 2, top: c.y - h / 2, width: w, height: h };
}
