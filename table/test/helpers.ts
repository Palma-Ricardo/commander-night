// Synthetic-state builders for the headless layout/camera tests (design §12:
// layoutWorld at many board densities, layoutScreen at many viewports). Minimal,
// typed GameState pieces — tsc checks every field against the wire model.

import type { Card, CommandObject, GameState, Permanent, Player } from '@night/core';
import type { Size } from '../src/layout/types';

let idc = 0;
export const cid = (tag = 'c'): string => `${tag}-${(++idc).toString(16).padStart(4, '0')}`;

export function mkCard(name: string, types: string[], o: Partial<Card> = {}): Card {
  return {
    id: o.id ?? cid(), name, set: o.set ?? 'CMR', number: o.number ?? '1',
    manaValue: o.manaValue ?? 0, types,
    subtypes: o.subtypes ?? [], supertypes: o.supertypes ?? [], colors: o.colors ?? [], text: o.text ?? [],
    ...o,
  };
}

export const mkLand = (name = 'Forest'): Card => mkCard(name, ['LAND']);
export const mkCreature = (name = 'Bear'): Card =>
  mkCard(name, ['CREATURE'], { power: '2', toughness: '2', colors: ['G'] });

export function mkPerm(controllerId: string, card: Card, tapped = false): Permanent {
  return { ...card, controllerId, tapped };
}

export function mkCommander(name = 'General'): CommandObject {
  return { ...mkCard(name, ['LEGENDARY', 'CREATURE'], { supertypes: ['Legendary'], power: '3', toughness: '3' }), kind: 'commander' };
}

export function mkPlayer(id: string, name: string, o: Partial<Player> & {
  lands?: number; creatures?: number;
} = {}): Player {
  const lands = Array.from({ length: o.lands ?? 3 }, () => mkPerm(id, mkLand()));
  const creatures = Array.from({ length: o.creatures ?? 2 }, () => mkPerm(id, mkCreature()));
  return {
    id, name, human: o.human ?? false, life: o.life ?? 40,
    manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
    librarySize: o.librarySize ?? 70, handSize: o.handSize ?? 7,
    battlefield: o.battlefield ?? [...creatures, ...lands],
    graveyard: o.graveyard ?? [],
    exile: o.exile ?? [],
    commandZone: o.commandZone ?? [mkCommander()],
    ...(o.flags !== undefined ? { flags: o.flags } : {}),
    ...(o.topCard !== undefined ? { topCard: o.topCard } : {}),
  };
}

export function mkState(players: Player[], meId: string, o: Partial<GameState> = {}): GameState {
  const me = players.find(p => p.id === meId) ?? players[0]!;
  return {
    gameId: 'test', status: 'active', rollbackTurnsAllowed: false,
    turn: { n: 1, phase: 'PRECOMBAT_MAIN', step: 'PRE_MAIN', activePlayerId: meId, priorityPlayerId: meId, ...o.turn },
    players,
    stack: o.stack ?? [],
    me: { playerId: me.id, hand: Array.from({ length: me.handSize }, () => mkCreature('Hand Card')) },
    ...(o.combat !== undefined ? { combat: o.combat } : {}),
  };
}

/** A full four-seat table with lightly-populated boards. */
export function fourSeats(): GameState {
  const p = [
    mkPlayer('p1', 'You', { human: true, life: 34, lands: 3, creatures: 2, graveyard: [mkCard('Bolt', ['INSTANT'])], handSize: 4 }),
    mkPlayer('p2', 'Ana', { life: 22, lands: 2, creatures: 1, handSize: 2 }),
    mkPlayer('p3', 'Tom', { life: 40, lands: 2, creatures: 1, handSize: 6 }),
    mkPlayer('p4', 'Marta', { life: 31, lands: 2, creatures: 1, exile: [mkCard('Path Target', ['CREATURE'])], handSize: 3 }),
  ];
  return mkState(p, 'p1');
}

export const SUPPORTED_VIEWPORTS: Size[] = [
  { w: 1280, h: 720 },
  { w: 1366, h: 768 },
  { w: 1600, h: 900 },
  { w: 1920, h: 1080 },
  { w: 2560, h: 1440 },
  { w: 3440, h: 1440 },   // ultrawide
];
