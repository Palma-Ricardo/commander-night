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

import type { Card, CombatGroup, CommandObject, GameState, Id, Permanent, Player } from '@night/core';
import type { ActorPlacement, PlacedActor, Point, Rect, Transform } from './types';

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

// An aura/equipment is not a permanent of its own on the felt: it is tucked under
// the thing it enchants, offset just enough for its name bar to show past the
// host's top edge (the art box's bar is 34/184 native ≈ 21 world px at
// BOARD_SCALE — so the peek clears it). The lateral step keeps a second and third
// attachment individually readable and clickable.
const ATTACH_PEEK = 24;          // per-attachment step past the host's top edge
const ATTACH_SIDE = 10;          // per-attachment lateral step

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
// Design §7.2: "you are bottom-left, and turn order runs clockwise from there."
// On screen (y grows downward) clockwise from bottom-left is up the left side,
// across the top, then down the right — NOT along the bottom first. Shipped
// counter-clockwise until 2026-07-30 (Issues.txt #17): the seat after you sat to
// your right on screen while the log said they followed you, so the compass and
// the 1–4 keys ran against the direction play actually moved.
const CORNER_BY_DISPLAY: Corner[] = [
  { left: true, bottom: true },    // 0 you        — bottom-left
  { left: true, bottom: false },   // 1 next       — top-left
  { left: false, bottom: false },  // 2 across     — top-right
  { left: false, bottom: true },   // 3 last       — bottom-right
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
// damaged, morphed, flipped) refuses to stack at all. Token *copies* do stack with
// each other — two identical Sandwurm Convergence copies (Anikthea + Doubling
// Season) are interchangeable — so `copy` folds into the key rather than
// disqualifying, keeping copies apart from a real printing but merging like copies.
// undefined ⇒ singleton.
function stackKey(p: Permanent): string | undefined {
  const basicLand = p.types.includes('LAND') && p.supertypes.includes('Basic');
  if (!basicLand && p.token !== true) return undefined;
  if ((p.attachments?.length ?? 0) > 0 || p.attachedTo !== undefined) return undefined;
  if ((p.damage ?? 0) > 0 || p.morph !== undefined || p.flipped === true
    || p.transformed === true || (p.faceDown ?? false)) return undefined;
  const counters = (p.counters ?? []).map(c => `${c.name}=${c.count}`).sort().join(',');
  return [
    p.token === true ? 'tok' : 'basic', p.name,
    p.copy === true ? 'copy' : '_',
    p.tapped ? 'T' : 'U', p.summoningSick === true ? 'S' : '_',
    p.power ?? '', p.toughness ?? '', counters,
  ].join('|');
}

const EMPTY_SPREAD: ReadonlySet<Id> = new Set();

/** Fold a row of permanents into cells, preserving first-seen order: each key's
 *  cell takes the slot where it first appears, later duplicates pile onto it.
 *  Ids in `spread` refuse to fold: during a multi-target ask the members of a
 *  pile must be individually clickable — folded, only the top card can ever be
 *  picked, so "destroy up to three artifacts" dead-ends past one treasure
 *  (Issues.txt #24). The cells tween apart and back as ordinary layout moves. */
function groupCells(perms: readonly Permanent[], spread: ReadonlySet<Id>): Permanent[][] {
  const cells: Permanent[][] = [];
  const byKey = new Map<string, Permanent[]>();
  for (const p of perms) {
    const key = spread.has(p.id) ? undefined : stackKey(p);
    if (key === undefined) { cells.push([p]); continue; }
    const cell = byKey.get(key);
    if (cell === undefined) { const fresh = [p]; byKey.set(key, fresh); cells.push(fresh); }
    else cell.push(p);
  }
  return cells;
}

// ── attachments ──────────────────────────────────────────────────────────────
// Auras and equipment don't get grid slots of their own: they ride under the
// permanent they are attached to, exactly as they sit on a real table. The host
// may live in another seat's quadrant (a Pacifism you control on their creature)
// or out in a battle lane (a sword on an attacker) — the attachment follows it
// wherever it ends up, which is why nesting is resolved across the whole table
// rather than per seat.

/** Who is attached to whom, table-wide. `nested` is every permanent that has been
 *  adopted by a host (so the grid and the lanes withhold it). `onPlayer` is the
 *  permanents attached to a *player* (curses): they sit in front of the cursed
 *  player, like paper — not in their caster's grid (Issues.txt #26). */
interface AttachIndex {
  byHost: ReadonlyMap<Id, Permanent[]>;
  nested: ReadonlySet<Id>;
  onPlayer: ReadonlyMap<Id, Permanent[]>;
}

/** Whether `p`'s host chain ends somewhere — corrupt state could hand us a cycle
 *  (A on B, B on A), which would nest forever, so those stay in the grid. */
function chainTerminates(p: Permanent, perms: ReadonlyMap<Id, Permanent>): boolean {
  const seen = new Set<Id>([p.id]);
  let cur = p;
  for (;;) {
    const nextId = cur.attachedTo;
    if (nextId === undefined) return true;
    const next = perms.get(nextId);
    if (next === undefined) return true;      // chain leaves the battlefield ⇒ a root
    if (seen.has(next.id)) return false;
    seen.add(next.id);
    cur = next;
  }
}

function attachIndex(state: GameState): AttachIndex {
  const perms = new Map<Id, Permanent>();
  for (const pl of state.players) for (const p of pl.battlefield) perms.set(p.id, p);
  const playerIds = new Set(state.players.map(p => p.id));
  const byHost = new Map<Id, Permanent[]>();
  const nested = new Set<Id>();
  const onPlayer = new Map<Id, Permanent[]>();
  for (const pl of state.players) {
    for (const p of pl.battlefield) {
      const hostId = p.attachedTo;
      if (hostId === undefined || hostId === p.id) continue;
      // Attached to a player (a curse): it moves to the cursed seat's grid.
      if (playerIds.has(hostId)) {
        const cursed = onPlayer.get(hostId);
        if (cursed === undefined) onPlayer.set(hostId, [p]); else cursed.push(p);
        nested.add(p.id);
        continue;
      }
      // `attachedTo` can otherwise be stale: anything we can't resolve to a
      // permanent on the felt keeps its own cell.
      if (!perms.has(hostId)) continue;
      if (!chainTerminates(p, perms)) continue;
      const kids = byHost.get(hostId);
      if (kids === undefined) byHost.set(hostId, [p]); else kids.push(p);
      nested.add(p.id);
    }
  }
  return { byHost, nested, onPlayer };
}

/** Emit everything attached to `host` (recursively — an aura can enchant an aura),
 *  tucked under the transform the host itself will take. Each attachment steps one
 *  peek further past the host's top edge, in the host's own rotated frame, so a
 *  tapped or lane-tilted host carries its kit along at the same angle. Emitted
 *  deepest-first and always *before* the host, so the host renders over them and
 *  every attachment shows exactly its name bar. */
function placeAttachments(
  seat: SeatLayout, host: Permanent, t: Transform, att: AttachIndex, out: PlacedActor[],
): void {
  const kids = att.byHost.get(host.id);
  if (kids === undefined) return;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  for (let i = kids.length - 1; i >= 0; i--) {
    const kid = kids[i]!;
    const dx = ATTACH_SIDE * (i + 1);
    const dy = -ATTACH_PEEK * (i + 1);
    const kt: Transform = {
      x: t.x + dx * cos - dy * sin,
      y: t.y + dx * sin + dy * cos,
      rotation: t.rotation,      // the cluster turns as one — the host's tap owns the angle
      scale: t.scale,
    };
    placeAttachments(seat, kid, kt, att, out);
    place(out, kid.id, kid, kid.id, {
      ...kt,
      zone: 'battlefield',
      // The seat whose quadrant the cluster sits in, not the attachment's own
      // controller: an aura on an opponent's creature is over *there*, and must
      // dim and brighten with the board it is lying on (§7.3 camera focus).
      ownerId: seat.player.id,
      faceUp: !(kid.faceDown ?? false),
      // Its own tap state still reads (dim + glyph) even though the angle is the
      // host's — a tapped Equipment must not silently look untapped.
      tapped: kid.tapped,
    });
  }
}

/** One grid slot: every member is placed (so each keeps its own actor, hit-test
 *  and affordance ring), co-located under a small depth offset so the cell reads
 *  as a tidy pile; only the topmost (last, so it renders over the rest) carries
 *  the "×N" tally. Whatever is attached to a member goes down first, under it. */
function placeCell(
  seat: SeatLayout, cell: readonly Permanent[], cx: number, cy: number,
  att: AttachIndex, out: PlacedActor[],
): void {
  const n = cell.length;
  cell.forEach((perm, i) => {
    const d = Math.min(i, 6);
    const t: Transform = {
      x: cx + d * 2,
      y: cy - d * 3,
      rotation: perm.tapped ? TAP_ANGLE : 0,
      scale: BOARD_SCALE,
    };
    placeAttachments(seat, perm, t, att, out);
    place(out, perm.id, perm, perm.id, {
      ...t,
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
function placeCells(
  seat: SeatLayout, cells: readonly Permanent[][], anchorY: number, rowStep: 1 | -1,
  att: AttachIndex, out: PlacedActor[],
): void {
  cells.forEach((cell, i) => {
    const col = i % seat.cols;
    const row = Math.floor(i / seat.cols);
    placeCell(
      seat, cell,
      seat.rowStartX + col * (CARD_W + GAP),
      anchorY + rowStep * row * (CARD_H + ROW_GAP),
      att, out,
    );
  });
}

/** Which row a permanent belongs to. A land that is *currently* a creature — an
 *  animated Dryad Arbor, a Nissa'd Forest, anything a continuous effect turned
 *  into a body — sits with the creatures, not in the mana row: it blocks, it
 *  attacks, and it has to march to a battle lane from somewhere that reads as the
 *  front line. `types` is the permanent's live type line (XMage's PermanentView
 *  reports post-effect types), so this flips both ways on its own: when the
 *  animation ends the land is a land again and the director tweens it home. */
function inLandRow(p: Permanent): boolean {
  return p.types.includes('LAND') && !p.types.includes('CREATURE');
}

function layoutBoard(
  seat: SeatLayout, inCombat: ReadonlySet<Id>, att: AttachIndex,
  spread: ReadonlySet<Id>, out: PlacedActor[],
): void {
  // The place setting (§7.2): non-land permanents (plus animated lands, see
  // `inLandRow`) are rows pinned to the seam and grow toward the rail; lands are
  // their own row pinned to the rail and grow back toward the seam. Both fold
  // identical basics/tokens into single cells first, so
  // eight Forests cost one slot — the board's answer to overflow (T4). Permanents
  // fighting in the seam (layoutCombat) are withheld from the grid entirely, and so
  // are attachments: they ride under their host, wherever the host is placed.
  const bf = seat.player.battlefield.filter(p => !inCombat.has(p.id) && !att.nested.has(p.id));
  // Curses enchanting this seat sit in front of the cursed player, like paper —
  // their caster's grid withheld them via `nested` (#26).
  const cursed = att.onPlayer.get(seat.player.id) ?? [];
  const nonlands = groupCells([...bf.filter(p => !inLandRow(p)), ...cursed], spread);
  const lands = groupCells(bf.filter(inLandRow), spread);
  placeCells(seat, nonlands, seat.boardTopY, seat.out, att, out);
  placeCells(seat, lands, seat.landRowY, -seat.out as 1 | -1, att, out);
}

// ── combat: the three battle lanes (§7.2/§9) ─────────────────────────────────
// An attacker marches to the border its quadrant shares with its defender's: a
// row along the horizontal seam for the seat across it, a column along the
// vertical seam for the side neighbour, and the table's centre corner for the
// diagonal seat (tilted 45° toward it). Attacking all three opponents mans all
// three borders at once. An unblocked attacker crosses the line slightly; a
// blocked one backs onto its own side, and each blocker stands directly across
// the border from its attacker — in line, matching its rotation — so every fight
// reads as a face-off over a fence. All pure layout: the director tweens cards
// into and out of these slots like any other transition, which *is* the §9
// attack/block motion (the damage-step lunge is scene juice on top).

const ATTACK_ADVANCE = 34;        // an unblocked attacker's centre crosses the border by this
const ATTACK_NUDGE_BACK = 36;     // a blocked attacker backs off to its own side
const BLOCK_ACROSS = 96;          // blocker's centre, across the border from its attacker
const BLOCK_FAN = CARD_W * 0.72;  // along-the-border spread of gang blockers
const CORNER_TILT = Math.PI / 4;  // the diagonal lane's lean toward its defender
const CORNER_SPREAD = CARD_W + GAP;  // fan step for multiple corner attackers
// Each seam lane is centred on the stretch of border it owns, which stops short
// of the table's centre corner — that zone belongs to the diagonal lane — so the
// three fronts read as separate engagements, not one pile-up at the middle.
const CORNER_CLEAR = 180;         // border kept free around the centre corner

type LaneKind = 'h' | 'v' | 'corner';

/** Which border an attacking quadrant shares with its defender's: the horizontal
 *  seam, the vertical seam, or just the centre corner. Undefined when they share
 *  a quadrant (corrupt state) — the combatant degrades to its grid slot. */
function laneKind(a: Corner, d: Corner): LaneKind | undefined {
  const across = a.left !== d.left;
  const over = a.bottom !== d.bottom;
  if (across && over) return 'corner';
  if (over) return 'h';
  if (across) return 'v';
  return undefined;
}

/** The seat a combat group attacks: the defending player's — or, for a
 *  planeswalker/battle defender, the seat whose battlefield holds it. */
function defenderSeat(defenderId: Id, seats: readonly SeatLayout[]): SeatLayout | undefined {
  for (const s of seats) {
    if (s.player.id === defenderId) return s;
    if (s.player.battlefield.some(p => p.id === defenderId)) return s;
  }
  return undefined;
}

/** Place every combatant of `state.combat` on its battle lane (see the block
 *  comment above) and return their ids so the grid withholds them. Emitted
 *  *after* the boards so combatants render above the rows they stepped out of.
 *  Deterministic: slots follow combat-group order, which the wire fixes. */
function layoutCombat(
  state: GameState, seats: readonly SeatLayout[], att: AttachIndex, out: PlacedActor[],
): Set<Id> {
  const ids = new Set<Id>();
  const combat: readonly CombatGroup[] = state.combat ?? [];
  if (combat.length === 0) return ids;

  const permOf = new Map<Id, { perm: Permanent; seat: SeatLayout }>();
  for (const seat of seats) {
    for (const perm of seat.player.battlefield) permOf.set(perm.id, { perm, seat });
  }

  // Pass 1 — bucket every resolvable attacker into its seat's lane toward its
  // defender. A stale id or an unknown/same-quadrant defender is skipped here,
  // so it degrades to the ordinary grid slot, never to a vanished card.
  interface Entry { perm: Permanent; g: CombatGroup }
  const lanes = new Map<string, { seat: SeatLayout; kind: LaneKind; entries: Entry[] }>();
  for (const g of combat) {
    for (const aid of g.attackerIds) {
      const hit = permOf.get(aid);
      // An attached permanent is already placed under its host (it can't legally
      // attack anyway) — taking a lane slot too would place it twice.
      if (hit === undefined || att.nested.has(aid)) continue;
      const dSeat = defenderSeat(g.defenderId, seats);
      if (dSeat === undefined) continue;
      const kind = laneKind(hit.seat.corner, dSeat.corner);
      if (kind === undefined) continue;
      const key = `${hit.seat.display}:${kind}`;
      let lane = lanes.get(key);
      if (lane === undefined) { lane = { seat: hit.seat, kind, entries: [] }; lanes.set(key, lane); }
      lane.entries.push({ perm: hit.perm, g });
    }
  }

  const placeCombatant = (perm: Permanent, seat: SeatLayout, x: number, y: number, tilt: number): void => {
    ids.add(perm.id);
    const t: Transform = { x, y, rotation: tilt, scale: BOARD_SCALE };
    placeAttachments(seat, perm, t, att, out);   // a creature marches with its kit on
    place(out, perm.id, perm, perm.id, {
      ...t, zone: 'battlefield',
      ownerId: seat.player.id, faceUp: !(perm.faceDown ?? false), tapped: perm.tapped,
    });
  };

  // Pass 2 — march each lane out. For every attacker: the border point its slot
  // holds, the unit attack direction across that border, and the lane's tilt.
  // Seam lanes centre their line-up on the border segment their quadrant owns
  // (rail margin at one end, the corner-clear zone at the other); the corner
  // lane fans about the corner itself.
  const centreX = WORLD.w / 2;
  const centreY = WORLD.h / 2;
  for (const lane of lanes.values()) {
    const seat = lane.seat;
    const q = seat.quadrant;
    const side: 1 | -1 = seat.corner.left ? 1 : -1;   // toward the other column
    const mid = (lane.entries.length - 1) / 2;
    let segMid = 0;
    if (lane.kind === 'h') {
      segMid = seat.corner.left
        ? (q.x + EDGE_MARGIN + centreX - CORNER_CLEAR) / 2
        : (centreX + CORNER_CLEAR + q.x + q.w - EDGE_MARGIN) / 2;
    } else if (lane.kind === 'v') {
      segMid = seat.corner.bottom
        ? (centreY + CORNER_CLEAR + q.y + q.h - EDGE_MARGIN) / 2
        : (q.y + EDGE_MARGIN + centreY - CORNER_CLEAR) / 2;
    }
    lane.entries.forEach((en, i) => {
      let bx: number, by: number, dirX: number, dirY: number, tilt: number;
      if (lane.kind === 'h') {          // row along the horizontal seam
        bx = segMid + (i - mid) * (CARD_W + GAP);
        by = centreY;
        dirX = 0; dirY = -seat.out; tilt = 0;
      } else if (lane.kind === 'v') {   // column along the vertical seam
        bx = centreX;
        by = segMid + (i - mid) * (CARD_H + GAP);
        dirX = side; dirY = 0; tilt = 0;
      } else {                          // the centre corner, fanned on the diagonal
        dirX = side * Math.SQRT1_2;
        dirY = -seat.out * Math.SQRT1_2;
        const off = (i - mid) * CORNER_SPREAD;
        bx = centreX - dirY * off;      // spread along the border (⊥ to the attack)
        by = centreY + dirX * off;
        tilt = side * CORNER_TILT;
      }
      const adv = en.g.blocked ? -ATTACK_NUDGE_BACK : ATTACK_ADVANCE;
      placeCombatant(en.perm, seat, bx + dirX * adv, by + dirY * adv, tilt);
      // Its blockers: directly across the border, in line, same rotation —
      // fanned along the border when several gang up. First placement wins if a
      // creature somehow blocks twice.
      const bMid = (en.g.blockerIds.length - 1) / 2;
      en.g.blockerIds.forEach((bid, j) => {
        const bHit = permOf.get(bid);
        if (bHit === undefined || ids.has(bid) || att.nested.has(bid)) return;
        const f = (j - bMid) * BLOCK_FAN;
        placeCombatant(
          bHit.perm, bHit.seat,
          bx + dirX * BLOCK_ACROSS - dirY * f,
          by + dirY * BLOCK_ACROSS + dirX * f,
          tilt,
        );
      });
    });
  }
  return ids;
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
  const top = seat.player.topCard;   // revealed while a Future Sight-class effect holds (§6)
  const backs = top !== undefined ? n - 1 : n;
  for (let i = 0; i < backs; i++) {
    place(out, `${seat.player.id}:library:${i}`, undefined, undefined, {
      x: anchor.x + outward * i * PILE_STEP_OUT,
      y: anchor.y - i * PILE_STEP_AWAY,
      rotation: 0, scale: PILE_SCALE, zone: 'library', ownerId: seat.player.id, faceUp: false,
    });
  }
  if (top !== undefined && seat.player.librarySize > 0) {
    // The real card, face-up, under its real id: hover previews it, a prompt can
    // ring it, and drawing it tweens library → hand as an ordinary actor move.
    place(out, top.id, top, top.id, {
      x: anchor.x + outward * backs * PILE_STEP_OUT,
      y: anchor.y - backs * PILE_STEP_AWAY,
      rotation: 0, scale: PILE_SCALE, zone: 'library', ownerId: seat.player.id, faceUp: true,
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

/** The whole felt as placed actors — pure, viewport-independent (design §6.2).
 *  The stack is *not* here: it moved to the screen-space layer (`layoutScreen`, a
 *  right-edge pile) so it never hides behind the felt's perspective and shares a
 *  layer with the hand for the cast animation (T4). */
export function layoutWorld(state: GameState, spread: ReadonlySet<Id> = EMPTY_SPREAD): PlacedActor[] {
  const out: PlacedActor[] = [];
  const me = state.me.playerId;
  const seats = seatLayouts(state);

  // Combat is computed first (the grid must withhold the fighters) but appended
  // last, so combatants render above the rows they stepped out of.
  const att = attachIndex(state);
  const combatants: PlacedActor[] = [];
  const inCombat = layoutCombat(state, seats, att, combatants);

  for (const seat of seats) {
    layoutBoard(seat, inCombat, att, spread, out);
    layoutLibrary(seat, out);
    layoutPile(seat, 'graveyard', seat.player.graveyard, out);
    layoutPile(seat, 'exile', seat.player.exile, out);
    layoutPile(seat, 'command', seat.player.commandZone as CommandObject[], out);
    if (seat.player.id !== me) layoutOpponentHand(seat, out);
  }

  out.push(...combatants);
  return out;
}
