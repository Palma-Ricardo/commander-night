import { describe, expect, it } from 'vitest';
import {
  displaySeats, layoutWorld, pileJitter, seatLayouts, seatOfPlayer,
  seatQuadrantRect, WORLD,
} from '../src/layout/world';
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

  it('centres the stack on the felt seam', () => {
    const state = mkState([mkPlayer('p1', 'You', { human: true })], 'p1', {
      stack: [{ id: cid('stk'), kind: 'spell', controllerId: 'p1', text: [], card: mkCard('Cultivate', ['SORCERY']) }],
    });
    const stack = layoutWorld(state).filter(p => p.placement.zone === 'stack');
    expect(stack.length).toBe(1);
    expect(stack[0]!.placement.x).toBeCloseTo(WORLD.w / 2, 5);
    expect(stack[0]!.placement.y).toBeCloseTo(WORLD.h / 2, 5);
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

describe('pileJitter', () => {
  it('is deterministic and bounded', () => {
    const id = cid('card');
    expect(pileJitter(id)).toEqual(pileJitter(id));
    const j = pileJitter(id);
    expect(Math.abs(j.dx)).toBeLessThanOrEqual(3.6);
    expect(Math.abs(j.dy)).toBeLessThanOrEqual(3.6);
    expect(Math.abs(j.drot)).toBeLessThanOrEqual(0.046);
  });

  it('differs across ids (no constant offset)', () => {
    const a = pileJitter('aaaa-1111');
    const b = pileJitter('bbbb-2222');
    expect(a).not.toEqual(b);
  });
});
