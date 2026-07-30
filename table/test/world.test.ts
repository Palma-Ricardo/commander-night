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

  it('a revealed topCard rides the library pile face-up, under its real id (§6)', () => {
    const top = mkCard('Future Sight Peek', ['SORCERY']);
    const state = mkState(
      [mkPlayer('p1', 'You', { human: true, librarySize: 70, topCard: top })], 'p1');
    const lib = layoutWorld(state).filter(p => p.placement.zone === 'library');
    expect(lib.length).toBe(8);                             // top replaces one back
    const face = lib.filter(p => p.placement.faceUp);
    expect(face.length).toBe(1);
    expect(face[0]!.objectId).toBe(top.id);                 // hover/affordance address it
    expect(face[0]!.card?.name).toBe('Future Sight Peek');
    // it sits on top: further from the camera than every back (y shrinks with depth)
    const minBackY = Math.min(...lib.filter(p => !p.placement.faceUp).map(p => p.placement.y));
    expect(face[0]!.placement.y).toBeLessThan(minBackY);
  });

  it('spread ids refuse to fold, so pile members become individually clickable (#24)', () => {
    const treasures = Array.from({ length: 4 }, () =>
      mkPerm('p1', mkCard('Treasure', ['ARTIFACT'], { token: true })));
    const you = mkPlayer('p1', 'You', { human: true, battlefield: treasures });
    const state = mkState([you], 'p1');

    // folded by default: all four share one cell (co-located, ~2px steps)
    const folded = layoutWorld(state).filter(p => treasures.some(t => t.id === p.objectId));
    expect(folded.length).toBe(4);
    const xs = new Set(folded.map(p => Math.round(p.placement.x / 10)));
    expect(xs.size).toBe(1);

    // spread: each takes its own grid cell
    const spread = layoutWorld(state, new Set(treasures.map(t => t.id)))
      .filter(p => treasures.some(t => t.id === p.objectId));
    expect(spread.length).toBe(4);
    const spreadXs = new Set(spread.map(p => Math.round(p.placement.x / 10)));
    expect(spreadXs.size).toBeGreaterThan(1);
    expect(spread.every(p => p.placement.count === undefined)).toBe(true);   // no ×N tally
  });

  it('a curse sits in front of the cursed player, not its caster (#26)', () => {
    const caster = mkPlayer('p1', 'Caster', { human: true });
    const victim = mkPlayer('p2', 'Victim', {});
    const curse: Permanent = {
      ...mkPerm('p1', mkCard('Curse of Opulence', ['ENCHANTMENT'], { subtypes: ['Aura', 'Curse'] })),
      attachedTo: 'p2',
    };
    caster.battlefield = [...caster.battlefield, curse];
    const placed = layoutWorld(mkState([caster, victim], 'p1'));
    const hit = placed.find(p => p.objectId === curse.id);
    expect(hit).toBeDefined();
    expect(hit!.placement.ownerId).toBe('p2');            // the cursed seat's grid
    expect(hit!.placement.zone).toBe('battlefield');
    // and only once — the caster's grid withheld it
    expect(placed.filter(p => p.objectId === curse.id).length).toBe(1);
  });

  it('a topCard on a one-card library is the whole pile', () => {
    const top = mkCard('Last One', ['INSTANT']);
    const state = mkState(
      [mkPlayer('p1', 'You', { human: true, librarySize: 1, topCard: top })], 'p1');
    const lib = layoutWorld(state).filter(p => p.placement.zone === 'library');
    expect(lib.length).toBe(1);
    expect(lib[0]!.placement.faceUp).toBe(true);
    expect(lib[0]!.objectId).toBe(top.id);
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

  it('moves an animated land up to the creature rows, and home again when it wears off', () => {
    // A 3/3 Forest fights, so it has to stand with the creatures — leaving it in the
    // mana row makes it march to a battle lane from the back of the quadrant.
    const animated = mkCard('Forest', ['LAND', 'CREATURE'], {
      id: 'awoken', supertypes: ['Basic'], power: '3', toughness: '3',
    });
    const dormant = mkCard('Forest', ['LAND'], { id: 'awoken', supertypes: ['Basic'] });
    const board = (forest: Card) => mkPlayer('p1', 'You', {
      human: true,
      battlefield: [
        mkPerm('p1', mkCreature('A')),
        mkPerm('p1', mkCard('Island', ['LAND'], { id: 'plain-land' })),
        mkPerm('p1', forest),
      ],
    });
    const seat = seatLayouts(mkState([board(animated)], 'p1'))[0]!;
    const yOf = (pl: PlacedActor[], id: string): number =>
      pl.find(p => p.placement.zone === 'battlefield' && p.card?.id === id)!.placement.y;

    const awake = layoutWorld(mkState([board(animated)], 'p1'));
    expect(yOf(awake, 'awoken')).toBeCloseTo(seat.boardTopY, 5);      // with the creatures
    expect(yOf(awake, 'plain-land')).toBeCloseTo(seat.landRowY, 5);   // the plain land stays put

    // Same permanent, animation ended: the type line is back to LAND, so is the card.
    const asleep = layoutWorld(mkState([board(dormant)], 'p1'));
    expect(yOf(asleep, 'awoken')).toBeCloseTo(seat.landRowY, 5);
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

describe('attachments nest under their host', () => {
  // A bear wearing a sword and an aura, plus a bare bear to compare grid slots.
  const enchanted = (opts: { hostTapped?: boolean } = {}) => {
    const host = mkPerm('p1', mkCreature('Host'), opts.hostTapped ?? false);
    const aura = { ...mkPerm('p1', mkCard('Pacifism', ['ENCHANTMENT'])), attachedTo: host.id };
    const gear = { ...mkPerm('p1', mkCard('Bonesplitter', ['ARTIFACT'])), attachedTo: host.id };
    const bare = mkPerm('p1', mkCreature('Bare'));
    host.attachments = [aura.id, gear.id];
    const you = mkPlayer('p1', 'You', { human: true, battlefield: [aura, host, gear, bare] });
    return { state: mkState([you], 'p1'), host, aura, gear, bare };
  };

  it('tucks each attachment onto its host instead of giving it a grid slot', () => {
    const { state, host, aura, gear, bare } = enchanted();
    const placed = byKey(layoutWorld(state));
    const h = placed.get(host.id)!.placement;
    const a = placed.get(aura.id)!.placement;
    const g = placed.get(gear.id)!.placement;
    // Both attachments sit on the host's cell, peeking past its top edge (smaller
    // y is toward the far edge = up the screen for every seat), stepped so each
    // one's name bar shows. Neither took a column of its own.
    for (const at of [a, g]) {
      expect(Math.abs(at.x - h.x)).toBeLessThan(40);
      expect(at.y).toBeLessThan(h.y);
      expect(h.y - at.y).toBeLessThan(80);
    }
    expect(a.y).not.toBeCloseTo(g.y, 0);                    // stepped, not co-located
    // The bare creature is the host's only grid neighbour: the board is two cells.
    expect(placed.get(bare.id)!.placement.y).toBeCloseTo(h.y, 5);
    const cellXs = new Set([h.x, placed.get(bare.id)!.placement.x]);
    expect(cellXs.size).toBe(2);
  });

  it('renders the host over its attachments (layout order is z order)', () => {
    const { state, host, aura, gear } = enchanted();
    const order = layoutWorld(state).map(p => p.key);
    expect(order.indexOf(aura.id)).toBeLessThan(order.indexOf(host.id));
    expect(order.indexOf(gear.id)).toBeLessThan(order.indexOf(host.id));
  });

  it('turns the whole cluster with a tapped host, keeping each tap state', () => {
    const { state, host, aura } = enchanted({ hostTapped: true });
    const placed = byKey(layoutWorld(state));
    const h = placed.get(host.id)!.placement;
    const a = placed.get(aura.id)!.placement;
    expect(h.rotation).not.toBe(0);
    expect(a.rotation).toBeCloseTo(h.rotation, 5);   // the kit leans with its host
    expect(a.tapped).toBe(false);                    // …but reports its own tap state
  });

  it('marches a creature into the battle lane with its kit on', () => {
    const { state, host, aura, gear } = enchanted();
    state.players.push(mkPlayer('p2', 'Ana', { battlefield: [] }));   // someone to swing at
    const grid = byKey(layoutWorld(state));
    state.combat = [{ attackerIds: [host.id], defenderId: 'p2', blockerIds: [], blocked: false }];
    const placed = byKey(layoutWorld(state));
    const h = placed.get(host.id)!.placement;
    expect(h.x).not.toBeCloseTo(grid.get(host.id)!.placement.x, 0);   // it left the grid
    for (const id of [aura.id, gear.id]) {
      const at = placed.get(id)!.placement;
      expect(Math.hypot(at.x - h.x, at.y - h.y)).toBeLessThan(80);    // came along
    }
  });

  it('follows its host across the table — an aura on an opponent’s creature', () => {
    const host = mkPerm('p2', mkCreature('Theirs'));
    const aura = { ...mkPerm('p1', mkCard('Pacifism', ['ENCHANTMENT'])), attachedTo: host.id };
    const you = mkPlayer('p1', 'You', { human: true, battlefield: [aura] });
    const them = mkPlayer('p2', 'Ana', { battlefield: [host] });
    const placed = byKey(layoutWorld(mkState([you, them], 'p1')));
    const h = placed.get(host.id)!.placement;
    const a = placed.get(aura.id)!.placement;
    expect(Math.hypot(a.x - h.x, a.y - h.y)).toBeLessThan(80);
    expect(inRect(placed.get(aura.id)!, seatQuadrantRect(1), 90)).toBe(true);
    // It dims and brightens with the board it is lying on (§7.3), not with mine.
    expect(a.ownerId).toBe('p2');
  });

  it('keeps an unresolvable or cyclic attachment in the grid, never vanished', () => {
    const stray = { ...mkPerm('p1', mkCard('Curse', ['ENCHANTMENT'])), attachedTo: 'p1' };   // attached to a *player*
    const a = mkPerm('p1', mkCard('A', ['ENCHANTMENT']));
    const b = mkPerm('p1', mkCard('B', ['ENCHANTMENT']));
    const cyc = [{ ...a, attachedTo: b.id }, { ...b, attachedTo: a.id }];                    // corrupt: A↔B
    const you = mkPlayer('p1', 'You', { human: true, battlefield: [stray, ...cyc] });
    const placed = byKey(layoutWorld(mkState([you], 'p1')));
    for (const p of [stray, a, b]) expect(placed.has(p.id)).toBe(true);
    // …each in its own cell, and nothing placed twice.
    const xs = new Set([stray, a, b].map(p => placed.get(p.id)!.placement.x));
    expect(xs.size).toBe(3);
  });
});

describe('combat: the three battle lanes (§7.2/§9)', () => {
  const SEAM_X = WORLD.w / 2;
  const SEAM_Y = WORLD.h / 2;

  // p2 (bottom-right) attacks p1 (bottom-left): the vertical-seam lane.
  const combatState = (blocked: boolean): { state: ReturnType<typeof fourSeats>; atkId: string; blkId: string } => {
    const state = fourSeats();
    const atk = state.players[1]!.battlefield.find(p => p.types.includes('CREATURE'))!;
    const blk = state.players[0]!.battlefield.find(p => p.types.includes('CREATURE'))!;
    state.combat = [{
      attackerIds: [atk.id], defenderId: 'p1',
      blockerIds: blocked ? [blk.id] : [], blocked,
    }];
    return { state, atkId: atk.id, blkId: blk.id };
  };

  it('a side-neighbour attacker marches to the vertical seam and crosses it, unrotated', () => {
    const { state, atkId } = combatState(false);
    const grid = byKey(layoutWorld({ ...state, combat: undefined }));
    const placed = byKey(layoutWorld(state));
    const attacker = placed.get(atkId)!;
    // p2 sits bottom-right: its column is x > SEAM_X. The attacker crosses the line…
    expect(attacker.placement.x).toBeLessThan(SEAM_X);
    // …centred on its own (bottom) stretch of the border, clear of the corner zone…
    expect(attacker.placement.y).toBeGreaterThan(SEAM_Y + 150);
    expect(attacker.placement.y).toBeLessThan(WORLD.h - 100);
    // …edge lanes carry no rotation, and it genuinely left its grid slot.
    expect(attacker.placement.rotation).toBe(0);
    expect(attacker.placement.x).not.toBeCloseTo(grid.get(atkId)!.placement.x, 0);
    expect(attacker.placement.zone).toBe('battlefield');
    expect(attacker.placement.ownerId).toBe('p2');
  });

  it('a blocked attacker backs onto its own side of the border', () => {
    const b = combatState(true);
    const o = combatState(false);
    const blocked = byKey(layoutWorld(b.state)).get(b.atkId)!;
    const open = byKey(layoutWorld(o.state)).get(o.atkId)!;
    expect(blocked.placement.x).toBeGreaterThan(SEAM_X);             // its own (right) side
    expect(blocked.placement.x).toBeGreaterThan(open.placement.x);   // behind its unblocked spot
  });

  it('a blocker stands directly across the border, in line with its attacker', () => {
    const { state, atkId, blkId } = combatState(true);
    const placed = byKey(layoutWorld(state));
    const grid = byKey(layoutWorld({ ...state, combat: undefined }));
    const atk = placed.get(atkId)!.placement;
    const blk = placed.get(blkId)!.placement;
    expect(blk.zone).toBe('battlefield');
    expect(blk.ownerId).toBe('p1');
    expect(blk.x).not.toBeCloseTo(grid.get(blkId)!.placement.x, 0);  // left its grid slot
    expect(blk.x).toBeLessThan(SEAM_X);                              // the defender's side
    expect(blk.y).toBeCloseTo(atk.y, 5);                             // in line across the seam
    expect(blk.rotation).toBe(atk.rotation);                         // matching rotation
    const dist = Math.hypot(blk.x - atk.x, blk.y - atk.y);
    expect(dist).toBeGreaterThan(100);                               // a face-off, not a pile-up
    expect(dist).toBeLessThan(180);
  });

  it('the seat across the table fights along the horizontal seam, centred on its stretch', () => {
    const state = fourSeats();
    const both = state.players[0]!.battlefield.filter(p => p.types.includes('CREATURE'));
    const atk = both[0]!;
    state.combat = [{ attackerIds: [atk.id], defenderId: 'p4', blockerIds: [], blocked: false }];
    const attacker = byKey(layoutWorld(state)).get(atk.id)!;
    // p1 (bottom-left) → p4 (top-left): crosses the horizontal seam, on its own
    // column, clear of the centre corner (that zone belongs to the diagonal lane).
    expect(attacker.placement.y).toBeLessThan(SEAM_Y);
    expect(attacker.placement.y).toBeGreaterThan(SEAM_Y - 60);
    expect(attacker.placement.x).toBeLessThan(SEAM_X - 150);
    expect(attacker.placement.rotation).toBe(0);
    // The line-up is centred: two attackers straddle the single attacker's spot.
    state.combat = [{ attackerIds: both.map(p => p.id), defenderId: 'p4', blockerIds: [], blocked: false }];
    const pair = byKey(layoutWorld(state));
    const xs = both.map(p => pair.get(p.id)!.placement.x);
    expect((xs[0]! + xs[1]!) / 2).toBeCloseTo(attacker.placement.x, 5);
  });

  it('the diagonal seat is fought at the centre corner, tilted 45° toward it', () => {
    const state = fourSeats();
    const atk = state.players[0]!.battlefield.find(p => p.types.includes('CREATURE'))!;
    state.combat = [{ attackerIds: [atk.id], defenderId: 'p3', blockerIds: [], blocked: false }];
    const attacker = byKey(layoutWorld(state)).get(atk.id)!;
    // p1 (bottom-left) → p3 (top-right): at the table's centre, leaning up-right.
    expect(Math.abs(attacker.placement.x - SEAM_X)).toBeLessThan(60);
    expect(Math.abs(attacker.placement.y - SEAM_Y)).toBeLessThan(60);
    expect(attacker.placement.rotation).toBeCloseTo(Math.PI / 4, 5);
  });

  it('combatants are placed exactly once — no double placement with the grid', () => {
    const { state } = combatState(true);
    const placed = layoutWorld(state);
    expect(new Map(placed.map(p => [p.key, p])).size).toBe(placed.length);
  });

  it('a stale combat id degrades to the ordinary grid, never a vanished card', () => {
    const { state, atkId } = combatState(false);
    state.combat = [{ attackerIds: ['no-such-id'], defenderId: 'p1', blockerIds: [], blocked: false }];
    const placed = byKey(layoutWorld(state));
    expect(placed.has(atkId)).toBe(true);   // back in its grid slot
    const grid = byKey(layoutWorld({ ...state, combat: undefined }));
    expect(placed.get(atkId)!.placement).toEqual(grid.get(atkId)!.placement);
  });
});
