// layoutWorld — the pure, viewport-free, camera-free layout of everything that
// lives on the felt (design §6.2, §7.2): four seat quadrants, each a "place
// setting" of battlefield rows (spells toward the seam, lands behind), piles at
// the outer elbow, an upright-billboarded opponent hand, plus the shared stack
// across the centre seam. It takes **no viewport and no camera** — the table is a
// fixed-size world, so a permanent's table coordinate never depends on window
// size or where the lens points. That makes it the most testable function in the
// client: same state, same table coordinates, forever (design §6.2).
//
// Seats map to quadrants exactly as the §7.2 mockup: you are bottom-left and turn
// order runs clockwise — You(BL) → next(BR) → next(TR) → next(TL). Your seat is
// fixed regardless of lobby order, so the players array is rotated to put `me`
// first (`displaySeats`). Cards always billboard upright; seat identity is carried
// by the furniture (nameplate, lamplight, piles), never by rotating opponents'
// cards (§7.2). No animation here — T2's director drives motion from these targets.

import type { Card, CommandObject, GameState, Id, Permanent, Player } from '@night/core';
import type { ActorPlacement, PlacedActor, Point, Rect } from './types';

// ── the fixed world ──────────────────────────────────────────────────────────

/** The felt's extent, in table units. A constant — never a function of the
 *  player count: short lobbies are AI-filled, so the world is always four seats. */
export const WORLD = { w: 2400, h: 1520 } as const;

const CARD_TEX = { w: 200, h: 280 } as const;   // native table-tier texture px
const BOARD_SCALE = 0.62;                        // permanents on the felt
const PILE_SCALE = 0.5;                          // piles read a touch smaller
const STACK_SCALE = 0.74;                        // the stack looms over the seam
const OPP_HAND_SCALE = 0.34;

const CARD_W = CARD_TEX.w * BOARD_SCALE;         // 124
const CARD_H = CARD_TEX.h * BOARD_SCALE;         // 173.6
const PILE_H = CARD_TEX.h * PILE_SCALE;          // 140

const GAP = 18;                  // between cards in a battlefield row
const ROW_GAP = 22;              // between wrapped rows
const SEAM_MARGIN = 46;          // felt centre → first (spells) row
const SIDE_MARGIN = 42;          // quadrant edge → row
const EDGE_MARGIN = 30;          // outer felt edge → pile/nameplate band

export const NAMEPLATE = { w: 214, h: 42 } as const;
const PILE_W = CARD_TEX.w * PILE_SCALE;          // 100
const PILE_GAP = 16;

export type PileZone = 'library' | 'graveyard' | 'exile' | 'command';
const PILE_ORDER: PileZone[] = ['library', 'graveyard', 'exile', 'command'];
const LIBRARY_MAX_VISIBLE = 8;   // a library is a stack of backs, not 70 actors

// ── seat → quadrant ──────────────────────────────────────────────────────────

interface Corner { left: boolean; bottom: boolean }

// Display index (0 = you) → quadrant corner, per the §7.2 mockup.
const CORNER_BY_DISPLAY: Corner[] = [
  { left: true, bottom: true },    // 0 you        — bottom-left
  { left: false, bottom: true },   // 1 next       — bottom-right
  { left: false, bottom: false },  // 2 across     — top-right
  { left: true, bottom: false },   // 3 last       — top-left
];

/** All the fixed geometry of one seat's place setting, shared by `layoutWorld`
 *  (to place cards) and the scene (to draw furniture). */
export interface SeatLayout {
  display: number;                 // 0 = you
  player: Player;
  corner: Corner;
  quadrant: Rect;
  out: 1 | -1;                     // sign from the seam toward the outer edge (y)
  boardTopY: number;               // centre-y of the seam-nearest board row
  rowStartX: number;               // centre-x of the first column
  cols: number;
  bandY: number;                   // centre-y of the nameplate + pile band
  nameplate: Rect;
  lamplight: { x: number; y: number; r: number };
  piles: Record<PileZone, Point>;  // pile anchor centres
  handFan: Point;                  // centre of the opponent hand fan
}

/** Rotate the seat array so `me` is display seat 0 (bottom-left); the rest keep
 *  their relative turn order clockwise around the table (§7.2). */
export function displaySeats(state: GameState): Player[] {
  const players = state.players;
  const n = players.length;
  if (n === 0) return [];
  let meIndex = players.findIndex(p => p.id === state.me.playerId);
  if (meIndex < 0) meIndex = 0;
  const out: Player[] = [];
  for (let d = 0; d < n; d++) {
    const p = players[(meIndex + d) % n];
    if (p !== undefined) out.push(p);
  }
  return out;
}

/** Display index of the seat holding `playerId`, or -1. Drives camera follow. */
export function seatOfPlayer(state: GameState, playerId: Id | undefined): number {
  if (playerId === undefined) return -1;
  return displaySeats(state).findIndex(p => p.id === playerId);
}

function quadrantRect(corner: Corner): Rect {
  const hw = WORLD.w / 2;
  const hh = WORLD.h / 2;
  return { x: corner.left ? 0 : hw, y: corner.bottom ? hh : 0, w: hw, h: hh };
}

/** The world rectangle a display seat occupies (0 = you, bottom-left). Exported
 *  so the camera framing assertions can check each quadrant lands in view. */
export function seatQuadrantRect(display: number): Rect {
  return quadrantRect(CORNER_BY_DISPLAY[((display % 4) + 4) % 4]!);
}

function seatGeometry(display: number, player: Player): SeatLayout {
  const corner = CORNER_BY_DISPLAY[display] ?? CORNER_BY_DISPLAY[0]!;
  const q = quadrantRect(corner);
  const out: 1 | -1 = corner.bottom ? 1 : -1;

  const seamEdge = corner.bottom ? q.y : q.y + q.h;        // felt-centre side
  const outerEdge = corner.bottom ? q.y + q.h : q.y;       // rail side

  const boardTopY = seamEdge + out * (SEAM_MARGIN + CARD_H / 2);
  const rowStartX = q.x + SIDE_MARGIN + CARD_W / 2;
  const cols = Math.max(4, Math.floor((q.w - 2 * SIDE_MARGIN) / (CARD_W + GAP)));

  const bandY = outerEdge - out * (EDGE_MARGIN + PILE_H / 2);

  // Nameplate at the outer horizontal corner; piles march inboard from it.
  const nameX = corner.left ? q.x + SIDE_MARGIN : q.x + q.w - SIDE_MARGIN - NAMEPLATE.w;
  const nameplate: Rect = { x: nameX, y: bandY - NAMEPLATE.h / 2, w: NAMEPLATE.w, h: NAMEPLATE.h };

  const pileStep = PILE_W + PILE_GAP;
  const firstPileX = corner.left
    ? nameX + NAMEPLATE.w + PILE_GAP + PILE_W / 2
    : nameX - PILE_GAP - PILE_W / 2;
  const dir = corner.left ? 1 : -1;
  const piles = {} as Record<PileZone, Point>;
  PILE_ORDER.forEach((zone, i) => {
    piles[zone] = { x: firstPileX + dir * i * pileStep, y: bandY };
  });

  // Opponent hand: a small fan at the front-centre of their board, clear of the
  // central stack column (each quadrant centre-x is far from the felt centre).
  const handFan: Point = { x: q.x + q.w / 2, y: seamEdge + out * 34 };

  return {
    display, player, corner, quadrant: q, out,
    boardTopY, rowStartX, cols, bandY, nameplate,
    lamplight: { x: q.x + q.w / 2, y: q.y + q.h / 2, r: Math.min(q.w, q.h) * 0.62 },
    piles, handFan,
  };
}

/** Every seat's fixed furniture geometry, in display order (0 = you). */
export function seatLayouts(state: GameState): SeatLayout[] {
  return displaySeats(state).map((p, d) => seatGeometry(d, p));
}

// ── deterministic pile jitter (design §8: never Math.random) ─────────────────

/** A stable per-card offset/rotation for pile scatter, derived from the UUID so
 *  it is identical across frames and reloads (§8). FNV-1a → small deltas. */
export function pileJitter(id: string): { dx: number; dy: number; drot: number } {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const a = (h & 0xff) / 255 - 0.5;
  const b = ((h >>> 8) & 0xff) / 255 - 0.5;
  const c = ((h >>> 16) & 0xff) / 255 - 0.5;
  return { dx: a * 7, dy: b * 7, drot: c * 0.09 };
}

// ── card placement ───────────────────────────────────────────────────────────

function place(
  out: PlacedActor[], key: string, card: Card | undefined, objectId: Id | undefined,
  p: ActorPlacement,
): void {
  out.push({ key, card, objectId, space: 'world', placement: p });
}

function placeGrid(seat: SeatLayout, perms: readonly Permanent[], startRow: number, out: PlacedActor[]): void {
  perms.forEach((perm, i) => {
    const col = i % seat.cols;
    const row = startRow + Math.floor(i / seat.cols);
    place(out, perm.id, perm, perm.id, {
      x: seat.rowStartX + col * (CARD_W + GAP),
      y: seat.boardTopY + seat.out * row * (CARD_H + ROW_GAP),
      rotation: perm.tapped ? Math.PI / 2 : 0,
      scale: BOARD_SCALE,
      zone: 'battlefield',
      ownerId: seat.player.id,
      faceUp: !(perm.faceDown ?? false),
    });
  });
}

function layoutBoard(seat: SeatLayout, out: PlacedActor[]): void {
  // Spells face the seam, lands sit strictly behind them (§7.2): non-lands fill
  // the seam-nearest rows, lands begin on the first row past them (never beside).
  const bf = seat.player.battlefield;
  const nonlands = bf.filter(p => !p.types.includes('LAND'));
  const lands = bf.filter(p => p.types.includes('LAND'));
  const spellRows = Math.ceil(nonlands.length / seat.cols);
  placeGrid(seat, nonlands, 0, out);
  placeGrid(seat, lands, spellRows, out);
}

function layoutPile(
  seat: SeatLayout, zone: PileZone, cards: readonly Card[], out: PlacedActor[],
): void {
  const anchor = seat.piles[zone];
  // Newest last renders on top (added later); depth offset reads as thickness.
  cards.forEach((card, i) => {
    const j = pileJitter(card.id);
    place(out, card.id, card, card.id, {
      x: anchor.x + i * 1.6 + j.dx,
      y: anchor.y - i * 2.2 + j.dy,
      rotation: j.drot,
      scale: PILE_SCALE,
      zone: zone === 'command' ? 'command' : zone,
      ownerId: seat.player.id,
      faceUp: !(card.faceDown ?? false),
    });
  });
}

function layoutLibrary(seat: SeatLayout, out: PlacedActor[]): void {
  // A stack of face-down backs conveying depth — not one actor per card. Synthetic
  // keys (library cards carry no id on the wire); T2 draws from the top.
  const anchor = seat.piles.library;
  const n = Math.min(seat.player.librarySize, LIBRARY_MAX_VISIBLE);
  for (let i = 0; i < n; i++) {
    place(out, `${seat.player.id}:library:${i}`, undefined, undefined, {
      x: anchor.x + i * 1.6,
      y: anchor.y - i * 2.2,
      rotation: 0, scale: PILE_SCALE, zone: 'library', ownerId: seat.player.id, faceUp: false,
    });
  }
}

function layoutOpponentHand(seat: SeatLayout, out: PlacedActor[]): void {
  const n = seat.player.handSize;
  const spread = OPP_HAND_SCALE * CARD_TEX.w * 0.5;
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) - 0.5 : 0;
    place(out, `${seat.player.id}:hand:${i}`, undefined, undefined, {
      x: seat.handFan.x + t * spread * n,
      y: seat.handFan.y + Math.abs(t) * 10 * seat.out,
      rotation: t * 0.1,
      scale: OPP_HAND_SCALE, zone: 'hand', ownerId: seat.player.id, faceUp: false,
    });
  }
}

function layoutStack(state: GameState, out: PlacedActor[]): void {
  const items = state.stack;
  const step = 150;
  const cx = WORLD.w / 2;
  const cy = WORLD.h / 2;
  items.forEach((item, i) => {
    place(out, item.id, item.card, item.card?.id, {
      x: cx - (items.length - 1) * (step / 2) + i * step,
      y: cy,
      rotation: 0, scale: STACK_SCALE, zone: 'stack', ownerId: item.controllerId, faceUp: true,
    });
  });
}

/** The whole felt as placed actors — pure, viewport-independent (design §6.2). */
export function layoutWorld(state: GameState): PlacedActor[] {
  const out: PlacedActor[] = [];
  const me = state.me.playerId;

  for (const seat of seatLayouts(state)) {
    layoutBoard(seat, out);
    layoutLibrary(seat, out);
    layoutPile(seat, 'graveyard', seat.player.graveyard, out);
    layoutPile(seat, 'exile', seat.player.exile, out);
    layoutPile(seat, 'command', seat.player.commandZone as CommandObject[], out);
    if (seat.player.id !== me) layoutOpponentHand(seat, out);
  }

  layoutStack(state, out);
  return out;
}
