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
  /** <1 ⇒ the layout wants this actor drawn partly transparent — currently only
   *  the ends of an elided opponent hand (Issues.txt #11), where the fade says
   *  "the fan goes on past here, the number is the truth". Multiplies with the
   *  §7.3 camera-focus dimming rather than replacing it. */
  alpha?: number;
  /** >1 ⇒ this actor is the visible top of a collapsed stack of identical
   *  permanents (basic lands / tokens); the render layer overlays a "×count"
   *  tally so eight Forests read as one cell, not eight (design T4). */
  count?: number;
  /** The effect a stack card actually puts on the stack, overlaid on the card's
   *  text-box region by the render layer (design §9, T4). A stack card renders as
   *  a full card face, but its printed box isn't always what's resolving: an
   *  **ability** renders as its *source* card, whose box lists every ability the
   *  permanent has, and a **modal** spell's box lists all its modes. So we cover
   *  the box with the one thing on the stack — the triggered ability's rules, or
   *  the chosen mode(s) — keeping the name and art above it visible. A plain spell
   *  has none: its printed box already is what resolves. `label` is the gilt header
   *  ("ABILITY" / "MODE"); `lines` the body (empty ⇒ header only). */
  stackEffect?: { label: string; lines: string[] };
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
