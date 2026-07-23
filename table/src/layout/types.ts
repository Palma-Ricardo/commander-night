// Pure layout types, shared by the layout functions (layoutWorld / layoutScreen),
// the camera, and the render layer — with **no Pixi import**, so the whole layout
// tier is exercised headlessly in vitest's node env (design §6.2: "no side
// effects, no renderer types, no time in any of the three"). CardActor re-exports
// Transform/ActorPlacement from here for its own use.

import type { Card, Id, Zone } from '@night/core';

export interface Size { w: number; h: number }

/** Axis-aligned rectangle, top-left origin, y-down (screen and world both). */
export interface Rect { x: number; y: number; w: number; h: number }

export interface Point { x: number; y: number }

export interface Transform { x: number; y: number; rotation: number; scale: number }

export interface ActorPlacement extends Transform {
  zone: Zone;
  ownerId?: Id;
  faceUp: boolean;
  /** A tapped battlefield permanent (design T4): the render layer dims the art and
   *  overlays a tap glyph; the ~30° turn rides on `rotation` from the layout. */
  tapped?: boolean;
}

/** Which coordinate space a placement lives in (design §7.1). World actors are
 *  transformed by the camera; screen actors (the hand) never move. */
export type ActorSpace = 'world' | 'screen';

export interface PlacedActor {
  key: string;
  card?: Card;         // undefined → face-down back (opponent hand, library)
  objectId?: Id;
  space: ActorSpace;
  placement: ActorPlacement;
}
