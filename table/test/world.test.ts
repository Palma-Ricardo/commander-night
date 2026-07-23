import { describe, expect, it } from 'vitest';
import {
  displaySeats, layoutWorld, seatLayouts, seatOfPlayer,
  seatQuadrantRect, WORLD,
} from '../src/layout/world';
import type { Card, Permanent } from '@night/core';
import type { PlacedActor } from '../src/layout/types';
import { cid, fourSeats, mkCard, mkCreature, mkLand, mkPerm, mkPlayer, mkState } from './helpers';

const byKey = (placed: PlacedActor[]): Map<string, PlacedActor> => new Map(placed.map(p => [p.key, p]));
const inRect = (p: PlacedActor, r: { x: number; y: number; w: number; h: number }, pad = 0): boolean =>
  p.placement.x >= r.x - pad && p.placement.x <= r.x + r.w + pad &&
  p.placement.y >= r.y - pad && p.placement.y <= r.y + r.h + pad;

describe('displaySeats', () => {
  it('puts me at display seat 0 and keeps relative turn order clockwise', () => {
    const state = fourSeats();
    const seats = displaySeats(state);
    expect(seats.map(p => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(seats[0]!.id).toBe(state.me.playerId);
  });

  it('rotates the array when me is not players[0]', () => {
    const state = mkState(
      [mkPlayer('p1', 'A'), mkPlayer('p2', 'B'), mkPlayer('p3', 'C'), mkPlayer('p4', 'D')],
      'p3',
    );
    expect(displaySeats(state).map(p => p.id)).toEqual(['p3', 'p4', 'p1', 'p2']);
    expect(seatOfPlayer(state, 'p3')).toBe(0);
    expect(seatOfPlayer(state, 'p1')).toBe(2);
    expect(seatOfPlayer(state, 'nobody')).toBe(-1);
  });
});

describe('layoutWorld', () => {
  it('places every enumerated object as a distinct actor', () => {
    const state = fourSeats();
    const placed = layoutWorld(state);
    const keys = byKey(placed);
    expect(keys.size).toBe(placed.length);   // no key collisions

    for (const pl of state.players) {
      for (const perm of pl.battlefield) expect(keys.has(perm.id)).toBe(true);
      for (const c of pl.graveyard) expect(keys.has(c.id)).toBe(true);
      for (const c of pl.exile) expect(keys.has(c.id)).toBe(true);
      for (const c of pl.commandZone) expect(keys.has(c.id)).toBe(true);
    }
  });

  it('is deterministic — identical input, identical placements', () => {
    const state = fourSeats();
    expect(layoutWorld(state)).toEqual(layoutWorld(state));
  });

  it('takes no viewport: the signature is state only', () => {
    // Compile-time contract (design §6.2). A runtime witness: two very different
    // "windows" cannot change the result because there is no window argument.
    expect(layoutWorld.length).toBe(1);
  });

  it('assigns each seat to its mockup quadrant (you bottom-left, clockwise)', () => {
    const state = fourSeats();
    const placed = layoutWorld(state);
    state.players.forEach((pl, i) => {
      const quad = seatQuadrantRect(i);
      const board = placed.filter(p => p.placement.ownerId === pl.id && p.placement.zone === 'battlefield');
      expect(board.length).toBeGreaterThan(0);
      // battlefield rows sit inside the owner's quadrant (half a card of overflow ok)
      for (const b of board) expect(inRect(b, quad, 90)).toBe(true);
    });
  });

  it('renders opponent hands as face-down backs, count = handSize; not my own', () => {
    const state = fourSeats();
    const placed = layoutWorld(state);
    for (const pl of state.players) {
      const backs = placed.filter(p => p.key.startsWith(`${pl.id}:hand:`));
      if (pl.id === state.me.playerId) {
        expect(backs.length).toBe(0);           // my hand is screen-space
      } else {
        expect(backs.length).toBe(pl.handSize);
        expect(backs.every(b => !b.placement.faceUp && b.card === undefined)).toBe(true);
      }
    }
  });

  it('caps the library back-stack but shows the pile', () => {
    const state = mkState([mkPlayer('p1', 'You', { human: true, librarySize: 70 })], 'p1');
    const lib = layoutWorld(state).filter(p => p.placement.zone === 'library');
    expect(lib.length).toBe(8);                 // LIBRARY_MAX_VISIBLE, not 70
    expect(lib.every(p => !p.placement.faceUp)).toBe(true);
  });

  it('lays spells toward the seam and lands strictly behind them', () => {
    const you = mkPlayer('p1', 'You', {
      human: true,
      battlefield: [
        mkPerm('p1', mkCreature('A')), mkPerm('p1', mkCreature('B')),
        mkPerm('p1', mkLand('L1')), mkPerm('p1', mkLand('L2')),
      ],
    });
    const placed = layoutWorld(mkState([you], 'p1'));
    const spells = placed.filter(p => p.placement.zone === 'battlefield' && !p.card?.types.includes('LAND'));
    const lands = placed.filter(p => p.placement.zone === 'battlefield' && p.card?.types.includes('LAND'));
    // You are the bottom-left seat: the seam is above (smaller y), so lands (behind)
    // have a strictly larger y than every spell.
    const maxSpellY = Math.max(...spells.map(p => p.placement.y));
    const minLandY = Math.min(...lands.map(p => p.placement.y));
    expect(minLandY).toBeGreaterThan(maxSpellY);
  });

  it('pins lands to the rail row, below every non-land permanent', () => {
    const you = mkPlayer('p1', 'You', {
      human: true,
      battlefield: [mkPerm('p1', mkCreature('A')), mkPerm('p1', mkLand('L1')), mkPerm('p1', mkLand('L2'))],
    });
    const seat = seatLayouts(mkState([you], 'p1'))[0]!;
    const placed = layoutWorld(mkState([you], 'p1'));
    const lands = placed.filter(p => p.placement.zone === 'battlefield' && p.card?.types.includes('LAND'));
    // The land row sits at the seat's rail-most land anchor, not tucked up behind
    // the spells — so it is pinned to the bottom regardless of how few spells there are.
    for (const l of lands) expect(l.placement.y).toBeCloseTo(seat.landRowY, 5);
    expect(seat.landRowY).toBeGreaterThan(seat.boardTopY);   // rail is below the seam for you
  });

  it('collapses identical basic lands into one cell with a ×N tally', () => {
    const basic = (): Card => mkCard('Forest', ['LAND'], { supertypes: ['Basic'] });
    const you = mkPlayer('p1', 'You', {
      human: true,
      battlefield: Array.from({ length: 8 }, () => mkPerm('p1', basic())),
    });
    const lands = layoutWorld(mkState([you], 'p1')).filter(p => p.placement.zone === 'battlefield');
    expect(lands.length).toBe(8);                                    // every Forest keeps its actor
    const tallied = lands.filter(p => (p.placement.count ?? 0) > 1);
    expect(tallied.length).toBe(1);                                  // exactly one top-of-stack tally
    expect(tallied[0]!.placement.count).toBe(8);
    // …all in a single cell: co-located up to the depth offset (< a card apart).
    const xs = lands.map(p => p.placement.x), ys = lands.map(p => p.placement.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(30);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(30);
  });

  it('stacks identical tokens but splits on tapped / counters / individuation', () => {
    const tok = (o: Partial<Permanent> = {}): Permanent =>
      ({ ...mkCard('Saproling', ['CREATURE'], { power: '1', toughness: '1', token: true }), controllerId: 'p1', tapped: false, ...o });
    const you = mkPlayer('p1', 'You', {
      human: true,
      battlefield: [
        tok(), tok(), tok(),                              // 3 identical → one ×3 cell
        tok({ tapped: true }),                            // tapped → its own cell
        tok({ counters: [{ name: 'P1P1', count: 1 }] }),  // a +1/+1 counter → its own cell
        tok({ attachedTo: 'someAura' }),                  // individuated → never stacks
      ],
    });
    const toks = layoutWorld(mkState([you], 'p1')).filter(p => p.placement.zone === 'battlefield');
    expect(toks.length).toBe(6);
    const tallies = toks.map(p => p.placement.count).filter((n): n is number => n !== undefined);
    expect(tallies).toEqual([3]);                         // only the identical trio collapses
  });

  it('handles a crowded board (20 permanents) with no collisions', () => {
    const bf = Array.from({ length: 20 }, (_, i) =>
      mkPerm('p1', i % 3 === 0 ? mkLand(`L${i}`) : mkCreature(`C${i}`)));
    const placed = layoutWorld(mkState([mkPlayer('p1', 'You', { human: true, battlefield: bf })], 'p1'));
    const board = placed.filter(p => p.placement.zone === 'battlefield');
    expect(board.length).toBe(20);
    expect(new Set(board.map(p => p.key)).size).toBe(20);
  });

  it('handles empty zones and empty state without crashing', () => {
    const bare = mkPlayer('p1', 'You', { human: true, battlefield: [], graveyard: [], exile: [], commandZone: [], librarySize: 0, handSize: 0 });
    expect(() => layoutWorld(mkState([bare], 'p1'))).not.toThrow();
    expect(layoutWorld(mkState([bare], 'p1')).length).toBe(0);
  });

  it('keeps the stack off the felt (it is a screen-space pile now)', () => {
    const state = mkState([mkPlayer('p1', 'You', { human: true })], 'p1', {
      stack: [{ id: cid('stk'), kind: 'spell', controllerId: 'p1', text: [], card: mkCard('Cultivate', ['SORCERY']) }],
    });
    expect(layoutWorld(state).some(p => p.placement.zone === 'stack')).toBe(false);
  });

  it('every world actor stays within the felt', () => {
    const placed = layoutWorld(fourSeats());
    for (const p of placed) {
      expect(p.placement.x).toBeGreaterThanOrEqual(-40);
      expect(p.placement.x).toBeLessThanOrEqual(WORLD.w + 40);
      expect(p.placement.y).toBeGreaterThanOrEqual(-40);
      expect(p.placement.y).toBeLessThanOrEqual(WORLD.h + 40);
    }
  });
});

describe('seatLayouts furniture', () => {
  it('gives each seat a nameplate and four pile anchors inside its quadrant', () => {
    const state = fourSeats();
    seatLayouts(state).forEach((seat, i) => {
      const quad = seatQuadrantRect(i);
      expect(seat.nameplate.x).toBeGreaterThanOrEqual(quad.x - 4);
      expect(seat.nameplate.x + seat.nameplate.w).toBeLessThanOrEqual(quad.x + quad.w + 4);
      for (const zone of ['library', 'graveyard', 'exile', 'command'] as const) {
        const a = seat.piles[zone];
        expect(a.x).toBeGreaterThanOrEqual(quad.x - 60);
        expect(a.x).toBeLessThanOrEqual(quad.x + quad.w + 60);
      }
    });
  });
});

describe('piles are tidy', () => {
  it('stacks each pile away-and-outward — a fixed step, no scatter or rotation', () => {
    // A graveyard of several cards: each card steps a fixed amount toward the far
    // edge (away from the camera, -y) and outward toward its corner (-x for a
    // left seat), and none is rotated (design: tidy stacks that read as height).
    const gy = Array.from({ length: 5 }, (_, i) => mkCard(`G${i}`, ['CREATURE']));
    const you = mkPlayer('p1', 'You', { human: true, graveyard: gy });   // bottom-left seat
    const pile = layoutWorld(mkState([you], 'p1')).filter(p => p.placement.zone === 'graveyard');
    expect(pile.length).toBe(5);
    const anchorX = pile[0]!.placement.x;
    const anchorY = pile[0]!.placement.y;
    pile.forEach((p, i) => {
      expect(p.placement.rotation).toBe(0);
      expect(p.placement.x).toBeCloseTo(anchorX - i * 1.6, 5);   // outward (left seat), exact step
      expect(p.placement.y).toBeCloseTo(anchorY - i * 2.2, 5);   // away from the camera, exact step
    });
  });
});
