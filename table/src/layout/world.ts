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

const CARD_TEX = { w: 200, h: 280 } as const;   // native portrait px (hand/stack/piles/hover)
// Battlefield permanents render as a landscape "art box" — a name bar over the art
// with the rules text trimmed off (design T4). Its native aspect is wider and
// shorter than a full card, so the board cell has its own size; the piles, the
// stack, the opponent hand and the hover preview all stay full portrait cards.
const ARTBOX_TEX = { w: 200, h: 184 } as const;  // native battlefield art-box px
const BOARD_SCALE = 0.62;                        // permanents on the felt
const PILE_SCALE = 0.42;                         // piles read a touch smaller
const STACK_SCALE = 0.74;                        // the stack looms over the seam
// The nameplate and an opponent's held fan share the rail band, so they read as
// one strip when they are the same height: the average of what each used to be
// (plate 42, a 0.3-scaled back 84 → 63). 63/280 = 0.225 sizes the backs to match.
export const OPP_HAND_SCALE = 0.225;             // an opponent's held fan (backs) — 63px tall

// A tapped permanent turns ~30°, not a full 90° (design T4): a landscape art box
// tilted a little reads as "tapped" without sprawling sideways and wrecking the
// grid. The dim + tap glyph (CardActor) carry the rest of the signal.
const TAP_ANGLE = 28 * Math.PI / 180;

const CARD_W = ARTBOX_TEX.w * BOARD_SCALE;       // 124 — battlefield cell width
const CARD_H = ARTBOX_TEX.h * BOARD_SCALE;       // ~114 — battlefield cell height
const PILE_H = CARD_TEX.h * PILE_SCALE;          // ~118
// A tapped card is rotated TAP_ANGLE, so its lowest corner reaches further than
// CARD_H/2 from the centre — the land row reserves this (not the upright half) so
// a tapped land in the front row clears the nameplate instead of dipping into it.
const CARD_TAPPED_HALF_H = (CARD_W / 2) * Math.sin(TAP_ANGLE) + (CARD_H / 2) * Math.cos(TAP_ANGLE);  // ~79

const GAP = 18;                  // between cards in a battlefield row
const ROW_GAP = 22;              // between wrapped rows
const SEAM_MARGIN = 46;          // felt centre → first (spells) row
const SIDE_MARGIN = 42;          // quadrant edge → row (non-pile side)
const EDGE_MARGIN = 30;          // outer felt edge → pile column / nameplate band
const INNER_GAP = 20;            // pile column → board rows
const HAND_GAP = 20;             // nameplate → opponent hand fan
const LAND_GAP = 10;             // clear gap between the (tapped-aware) land row and the nameplate

export const NAMEPLATE = { w: 214, h: 63 } as const;   // h matches the held-fan (see OPP_HAND_SCALE)
const PILE_W = CARD_TEX.w * PILE_SCALE;          // 84
const PILE_GAP = 16;             // vertical gap between piles in the column
const PILE_LABEL_GAP = 24;       // pile bottom → its count label baseline
// Per-card thickness step for a stacked pile. The vertical step is toward the far
// (top, small-y) edge — "away from the camera" — so under the perspective warp the
// stack recedes into height. The lateral step points *outward*, toward the pile's
// own corner (its sign flips with the seat side), so each card peeks out on the
// away-and-outward side the way the warp leans it. A single fixed +x only lined up
// at the top-right corner and skewed the other three; pure -y killed the peek and
// read flat. Outward-per-corner gives every pile the top-right's convincing lean.
const PILE_STEP_AWAY = 2.2;      // world px per card toward the far edge (recession)
const PILE_STEP_OUT = 1.6;       // world px per card outward (the visible thickness peek)
const PILE_DEPTH_MAX = 7;        // cards past this share the top slot (label carries true size)

export type PileZone = 'library' | 'graveyard' | 'exile' | 'command';
export const PILE_FOOTPRINT = { w: PILE_W, h: CARD_TEX.h * PILE_SCALE } as const;
export const PILE_LABEL: Record<PileZone, string> =
  { library: 'DECK', graveyard: 'GRAVE', exile: 'EXILE', command: 'CMD' };
// The pile column top→bottom for a *near* (bottom) seat: the command zone at the
// top, then exile, the deck, and the graveyard. A far (top) seat mirrors it (point
// symmetry — two people across one table), so every zone sits at the same physical
// spot relative to whoever owns it.
const PILE_COLUMN_NEAR: PileZone[] = ['command', 'exile', 'library', 'graveyard'];
const LIBRARY_MAX_VISIBLE = 8;   // a library is a stack of backs, not 70 actors

// The opponent's held fan advances this far per card. A longer stride spreads the
// fan wider for the same vertical rise, so the arc reads flatter — the top seats'
// backs no longer bunch into a steep hump against the rail (reviewed 2026-07-23).
const OPP_HAND_ADVANCE = OPP_HAND_SCALE * CARD_TEX.w * 0.5;

/** Half the width a face-down opponent hand of `n` cards occupies, for placing the
 *  count glyph just past the fan (shared by layout + the furniture pass). */
export function opponentHandHalfWidth(n: number): number {
  if (n <= 0) return 0;
  return ((n - 1) / 2) * OPP_HAND_ADVANCE + (OPP_HAND_SCALE * CARD_TEX.w) / 2;
}

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
  boardTopY: number;               // centre-y of the seam-nearest permanent row
  landRowY: number;                // centre-y of the rail-most land row (lands sit here)
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

  // Piles are a vertical column at the outer horizontal elbow (§7.2 ".zones"); the
  // board rows inset past it so cards never collide with the stacks.
  const boardInset = EDGE_MARGIN + PILE_W + INNER_GAP;
  const boardLeftX = q.x + (corner.left ? boardInset : SIDE_MARGIN);
  const boardRightX = q.x + q.w - (corner.left ? SIDE_MARGIN : boardInset);

  const boardTopY = seamEdge + out * (SEAM_MARGIN + CARD_H / 2);
  const rowStartX = boardLeftX + CARD_W / 2;
  const cols = Math.max(3, Math.floor((boardRightX - boardLeftX) / (CARD_W + GAP)));

  // The pile column, anchored at the player's outer corner. Far seats mirror the
  // near order so a zone lands at the same spot relative to whoever sits there.
  const pileColX = corner.left
    ? q.x + EDGE_MARGIN + PILE_W / 2
    : q.x + q.w - EDGE_MARGIN - PILE_W / 2;
  const columnOrder = corner.bottom ? PILE_COLUMN_NEAR : [...PILE_COLUMN_NEAR].reverse();
  const pileStep = PILE_H + PILE_LABEL_GAP + PILE_GAP;
  // The graveyard is the rail end of the order (§7.2): pin it a fixed margin off
  // the outer corner — a discard pile in the elbow, not floating mid-quadrant —
  // and run the column back toward the seam from there. Centring it over the
  // (short) 4-pile column left the corner conspicuously empty (reviewed 2026-07-23).
  // A pile's count label sits *below* it (toward larger y); for a bottom seat the
  // corner pile is the lowest, so its label would spill past the felt — lift the
  // whole column by that label's height so the text clears the corner.
  const cornerLabelRoom = corner.bottom ? PILE_LABEL_GAP : 0;
  const cornerPileY = outerEdge - out * (EDGE_MARGIN + PILE_H / 2 + cornerLabelRoom);
  const colTopY = corner.bottom ? cornerPileY - (columnOrder.length - 1) * pileStep : cornerPileY;
  const piles = {} as Record<PileZone, Point>;
  columnOrder.forEach((zone, i) => {
    piles[zone] = { x: pileColX, y: colTopY + i * pileStep };
  });

  // Nameplate + the opponent's held fan share the band at the outer vertical edge,
  // inboard of the pile column (§7.2 ".plate"). It hugs the rail — a nameplate is
  // short, so inset it by its *own* half-height, not a pile's, or the rail carries
  // a dead band (reviewed 2026-07-23). The fan sits beside the nameplate.
  const bandY = outerEdge - out * (EDGE_MARGIN + NAMEPLATE.h / 2);
  // Lands are the back row of the place setting — pinned to the rail, just inboard
  // of the nameplate band (§7.2). Permanents fill forward from the seam; lands fill
  // back from here, so your mana sits in front of you and your threats face the
  // contested centre. Overflow wraps toward the seam (see layoutBoard).
  const landRowY = bandY - out * (NAMEPLATE.h / 2 + LAND_GAP + CARD_TAPPED_HALF_H);
  const nameX = corner.left ? boardLeftX : boardRightX - NAMEPLATE.w;
  const nameplate: Rect = { x: nameX, y: bandY - NAMEPLATE.h / 2, w: NAMEPLATE.w, h: NAMEPLATE.h };
  const handHalf = opponentHandHalfWidth(player.handSize);
  const handFan: Point = corner.left
    ? { x: nameX + NAMEPLATE.w + HAND_GAP + handHalf, y: bandY }
    : { x: nameX - HAND_GAP - handHalf, y: bandY };

  return {
    display, player, corner, quadrant: q, out,
    boardTopY, landRowY, rowStartX, cols, bandY, nameplate,
    lamplight: { x: q.x + q.w / 2, y: q.y + q.h / 2, r: Math.min(q.w, q.h) * 0.62 },
    piles, handFan,
  };
}

/** Every seat's fixed furniture geometry, in display order (0 = you). */
export function seatLayouts(state: GameState): SeatLayout[] {
  return displaySeats(state).map((p, d) => seatGeometry(d, p));
}

// ── card placement ───────────────────────────────────────────────────────────

function place(
  out: PlacedActor[], key: string, card: Card | undefined, objectId: Id | undefined,
  p: ActorPlacement,
): void {
  out.push({ key, card, objectId, space: 'world', placement: p });
}

// A permanent's stack key: permanents sharing one collapse into a single grid cell
// (a "×N" tally, drawn by CardActor). Only basics and tokens ever stack — eight
// Forests or eight Saprolings are interchangeable, eight distinct nonbasics are
// not — and even then never across a difference the board must show: tapped, sick,
// counters, or P/T all split the stack, and any individuated permanent (attached,
// damaged, morphed, flipped, a copy) refuses to stack at all. undefined ⇒ singleton.
function stackKey(p: Permanent): string | undefined {
  const basicLand = p.types.includes('LAND') && p.supertypes.includes('Basic');
  if (!basicLand && p.token !== true) return undefined;
  if ((p.attachments?.length ?? 0) > 0 || p.attachedTo !== undefined) return undefined;
  if ((p.damage ?? 0) > 0 || p.morph !== undefined || p.flipped === true
    || p.transformed === true || p.copy === true || (p.faceDown ?? false)) return undefined;
  const counters = (p.counters ?? []).map(c => `${c.name}=${c.count}`).sort().join(',');
  return [
    p.token === true ? 'tok' : 'basic', p.name,
    p.tapped ? 'T' : 'U', p.summoningSick === true ? 'S' : '_',
    p.power ?? '', p.toughness ?? '', counters,
  ].join('|');
}

/** Fold a row of permanents into cells, preserving first-seen order: each key's
 *  cell takes the slot where it first appears, later duplicates pile onto it. */
function groupCells(perms: readonly Permanent[]): Permanent[][] {
  const cells: Permanent[][] = [];
  const byKey = new Map<string, Permanent[]>();
  for (const p of perms) {
    const key = stackKey(p);
    if (key === undefined) { cells.push([p]); continue; }
    const cell = byKey.get(key);
    if (cell === undefined) { const fresh = [p]; byKey.set(key, fresh); cells.push(fresh); }
    else cell.push(p);
  }
  return cells;
}

/** One grid slot: every member is placed (so each keeps its own actor, hit-test
 *  and affordance ring), co-located under a small depth offset so the cell reads
 *  as a tidy pile; only the topmost (last, so it renders over the rest) carries
 *  the "×N" tally. */
function placeCell(seat: SeatLayout, cell: readonly Permanent[], cx: number, cy: number, out: PlacedActor[]): void {
  const n = cell.length;
  cell.forEach((perm, i) => {
    const d = Math.min(i, 6);
    place(out, perm.id, perm, perm.id, {
      x: cx + d * 2,
      y: cy - d * 3,
      rotation: perm.tapped ? TAP_ANGLE : 0,
      scale: BOARD_SCALE,
      zone: 'battlefield',
      ownerId: seat.player.id,
      faceUp: !(perm.faceDown ?? false),
      tapped: perm.tapped,
      count: n > 1 && i === n - 1 ? n : undefined,
    });
  });
}

/** Lay a list of cells as a grid anchored at (rowStartX, anchorY), rows advancing
 *  in `rowStep` (toward the rail for permanents, toward the seam for lands). */
function placeCells(seat: SeatLayout, cells: readonly Permanent[][], anchorY: number, rowStep: 1 | -1, out: PlacedActor[]): void {
  cells.forEach((cell, i) => {
    const col = i % seat.cols;
    const row = Math.floor(i / seat.cols);
    placeCell(
      seat, cell,
      seat.rowStartX + col * (CARD_W + GAP),
      anchorY + rowStep * row * (CARD_H + ROW_GAP),
      out,
    );
  });
}

function layoutBoard(seat: SeatLayout, out: PlacedActor[]): void {
  // The place setting (§7.2): non-land permanents are rows pinned to the seam and
  // grow toward the rail; lands are their own row pinned to the rail and grow back
  // toward the seam. Both fold identical basics/tokens into single cells first, so
  // eight Forests cost one slot — the board's answer to overflow (T4).
  const bf = seat.player.battlefield;
  const nonlands = groupCells(bf.filter(p => !p.types.includes('LAND')));
  const lands = groupCells(bf.filter(p => p.types.includes('LAND')));
  placeCells(seat, nonlands, seat.boardTopY, seat.out, out);
  placeCells(seat, lands, seat.landRowY, -seat.out as 1 | -1, out);
}

function layoutPile(
  seat: SeatLayout, zone: PileZone, cards: readonly Card[], out: PlacedActor[],
): void {
  const anchor = seat.piles[zone];
  const outward = seat.corner.left ? -1 : 1;   // toward this pile's own outer corner
  // Newest last renders on top (added later); each card steps away from the camera
  // (toward the far edge) and outward toward its corner, so the warp reads the stack
  // as height and each card peeks out on the away-and-outward side. The step caps so
  // a deep pile can't climb into the zone above (the label carries true size).
  cards.forEach((card, i) => {
    const d = Math.min(i, PILE_DEPTH_MAX);
    place(out, card.id, card, card.id, {
      x: anchor.x + outward * d * PILE_STEP_OUT,
      y: anchor.y - d * PILE_STEP_AWAY,
      rotation: 0,
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
  const outward = seat.corner.left ? -1 : 1;   // toward this pile's own outer corner
  const n = Math.min(seat.player.librarySize, LIBRARY_MAX_VISIBLE);
  for (let i = 0; i < n; i++) {
    place(out, `${seat.player.id}:library:${i}`, undefined, undefined, {
      x: anchor.x + outward * i * PILE_STEP_OUT,
      y: anchor.y - i * PILE_STEP_AWAY,
      rotation: 0, scale: PILE_SCALE, zone: 'library', ownerId: seat.player.id, faceUp: false,
    });
  }
}

function layoutOpponentHand(seat: SeatLayout, out: PlacedActor[]): void {
  const n = seat.player.handSize;
  const mid = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const t = i - mid;
    place(out, `${seat.player.id}:hand:${i}`, undefined, undefined, {
      // A tight fan of backs beside the nameplate — the count is public, the faces
      // are not (§7.2). The middle rides highest (smaller y) so the arc's interior
      // is on the bottom, like a hand held from below — the same for every seat.
      x: seat.handFan.x + t * OPP_HAND_ADVANCE,
      y: seat.handFan.y + Math.abs(t) * 3,
      rotation: t * 0.045,
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
