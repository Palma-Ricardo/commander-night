// layoutScreen — the screen-space layer (design §7.1): your hand, fanned and
// pinned to the bottom edge, visible no matter where the camera points. This is
// the one function that sees the viewport; `layoutWorld` never does. Your hand is
// the sole zone in screen space, but it is still a Pixi actor (§10) so a cast can
// lift a card out of the fan and fly it into world space as one continuous actor
// (T2). Pure and headless — no renderer, no camera, no time.

import type { GameState } from '@night/core';
import type { PlacedActor, Size } from './types';

const CARD_TEX = { w: 200, h: 280 } as const;

/** Height of the bottom band reserved for the hand. The camera fits the world
 *  into the viewport *above* this band, so every seat stays clear of the hand
 *  (design §13 exit criterion). Shared with the camera's safe area. */
export function handBandHeight(viewport: Size): number {
  return Math.max(132, Math.min(240, Math.round(viewport.h * 0.19)));
}

/** The hand fan, in screen (CSS-pixel) coordinates, centred along the bottom. */
export function layoutScreen(state: GameState, viewport: Size): PlacedActor[] {
  const out: PlacedActor[] = [];
  const hand = state.me.hand;
  const n = hand.length;
  if (n === 0) return out;

  const band = handBandHeight(viewport);
  const scale = (band * 0.9) / CARD_TEX.h;         // card height ≈ 90% of the band
  const cardW = CARD_TEX.w * scale;
  const overlap = 0.62;                            // fan cards overlap when crowded
  const step = Math.min(cardW * overlap, (viewport.w - cardW - 48) / Math.max(1, n - 1));
  const spanW = step * (n - 1);
  const startX = viewport.w / 2 - spanW / 2;
  const baseY = viewport.h - band / 2;

  hand.forEach((card, i) => {
    const t = n > 1 ? i / (n - 1) - 0.5 : 0;       // -0.5 … 0.5 across the fan
    out.push({
      key: card.id, card, objectId: card.id, space: 'screen',
      placement: {
        x: startX + i * step,
        y: baseY + Math.abs(t) * band * 0.14,      // slight downward arc at the ends
        rotation: t * 0.1,
        scale,
        zone: 'hand',
        ownerId: state.me.playerId,
        faceUp: true,
      },
    });
  });

  return out;
}
