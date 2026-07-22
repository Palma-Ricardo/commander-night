// Flat layout for the T0 render (design §13: "render a captured keyframe as a
// flat scene"). A pure function state → placements, the precursor to T1's real
// layoutWorld/layoutScreen split (§6.2). No camera, no renderer types, no time.
// Seats map to quadrants (you bottom-left, then around); each seat's permanents
// flow in a grid at its quadrant, piles at the outer elbow, your hand fanned
// along the bottom edge, the stack across the centre seam. T1 replaces this with
// the surveyed quadrant world; T0 only needs it legible.

import type { Card, GameState, Id } from '@night/core';
import type { ActorPlacement } from '../render/CardActor';

export interface PlacedActor {
  key: string;
  card?: Card;        // undefined → face-down back
  objectId?: Id;
  placement: ActorPlacement;
}

export interface Size { w: number; h: number }

const CARD = { w: 200, h: 280 };          // native table-tier texture size
const BOARD_SCALE = 0.34;                 // permanents on the felt
const HAND_SCALE = 0.5;
const cw = CARD.w * BOARD_SCALE;
const ch = CARD.h * BOARD_SCALE;
const GAP = 10;

// players[] index → quadrant. Seat 0 (me) bottom-left; the rest fill around.
const QUADRANT: Array<{ qx: 0 | 1; qy: 0 | 1 }> = [
  { qx: 0, qy: 1 },   // you  — bottom-left
  { qx: 0, qy: 0 },   // top-left
  { qx: 1, qy: 0 },   // top-right
  { qx: 1, qy: 1 },   // bottom-right
];

function seatActors(
  state: GameState, seatIndex: number, size: Size, meId: Id, out: PlacedActor[],
): void {
  const pl = state.players[seatIndex];
  if (pl === undefined) return;
  const q = QUADRANT[seatIndex] ?? { qx: 0, qy: 0 };
  const halfW = size.w / 2;
  const halfH = size.h / 2;
  const x0 = q.qx * halfW + 24;
  const y0 = q.qy * halfH + 54;               // leave room for the nameplate band
  const cols = Math.max(4, Math.floor((halfW - 48) / (cw + GAP)));

  // commander + battlefield as one flowing grid
  const board: Array<{ card: Card; tapped: boolean }> = [
    ...pl.commandZone.map(c => ({ card: c as Card, tapped: false })),
    ...pl.battlefield.map(p => ({ card: p as Card, tapped: p.tapped })),
  ];
  board.forEach(({ card, tapped }, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    out.push({
      key: card.id, card, objectId: card.id,
      placement: {
        x: x0 + col * (cw + GAP) + cw / 2,
        y: y0 + row * (ch + GAP) + ch / 2,
        rotation: tapped ? Math.PI / 2 : 0,
        scale: BOARD_SCALE,
        zone: 'battlefield', ownerId: pl.id, faceUp: true,
      },
    });
  });

  // graveyard pile at the outer elbow (bottom of the quadrant)
  pl.graveyard.forEach((card, i) => {
    out.push({
      key: card.id, card, objectId: card.id,
      placement: {
        x: x0 + cw / 2 + i * 3,
        y: q.qy * halfH + halfH - ch / 2 - 16 + i * 3,
        rotation: 0, scale: BOARD_SCALE, zone: 'graveyard', ownerId: pl.id, faceUp: true,
      },
    });
  });

  // opponent hands: fanned face-down backs near the nameplate; my hand is drawn
  // separately along the screen bottom.
  if (pl.id !== meId) {
    for (let i = 0; i < pl.handSize; i++) {
      out.push({
        key: `${pl.id}:hand:${i}`, objectId: undefined,
        placement: {
          x: x0 + halfW - 90 - i * 16,
          y: q.qy * halfH + (q.qy === 0 ? 20 : halfH - 24),
          rotation: 0, scale: 0.18, zone: 'hand', ownerId: pl.id, faceUp: false,
        },
      });
    }
  }
}

export function layoutFlat(state: GameState, size: Size): PlacedActor[] {
  const out: PlacedActor[] = [];
  const meId = state.me.playerId;

  for (let i = 0; i < state.players.length; i++) seatActors(state, i, size, meId, out);

  // the stack, across the centre seam
  state.stack.forEach((item, i) => {
    out.push({
      key: item.id, card: item.card, objectId: item.card?.id,
      placement: {
        x: size.w / 2 - (state.stack.length - 1) * 20 + i * 40,
        y: size.h / 2,
        rotation: 0, scale: 0.42, zone: 'stack', ownerId: item.controllerId, faceUp: true,
      },
    });
  });

  // my hand, fanned along the bottom edge (screen space — §7.1/§8)
  const hand = state.me.hand;
  const handW = hand.length * (CARD.w * HAND_SCALE * 0.62);
  const startX = size.w / 2 - handW / 2;
  hand.forEach((card, i) => {
    const t = hand.length > 1 ? i / (hand.length - 1) - 0.5 : 0;
    out.push({
      key: card.id, card, objectId: card.id,
      placement: {
        x: startX + i * (CARD.w * HAND_SCALE * 0.62) + (CARD.w * HAND_SCALE) / 2,
        y: size.h - (CARD.h * HAND_SCALE) / 2 - 8 + Math.abs(t) * 24,
        rotation: t * 0.12,
        scale: HAND_SCALE, zone: 'hand', ownerId: meId, faceUp: true,
      },
    });
  });

  return out;
}
