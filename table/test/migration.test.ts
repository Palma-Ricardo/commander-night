// dockOwns (prompts-on-the-table §2, T8): the single strangler split both
// PromptDock and CornerCluster read. A prompt renders controls in exactly one
// place — the migrated kinds and board-reachable chooseTargets on the canvas +
// cluster, the carousel-bound bodies (cards[] grids, pile-zone candidates) in
// the dock until T9.

import { describe, expect, it } from 'vitest';
import type { Card, GameState, Prompt } from '@night/core/protocol/protocol';
import { dockOwns } from '../src/chrome/migration';

const card = (id: string, name: string): Card => ({
  id, name, set: 'xln', number: '1', manaValue: 2, types: ['Creature'],
  subtypes: [], supertypes: [], colors: [], text: [],
});

const state: GameState = {
  gameId: 'g1', status: 'active', rollbackTurnsAllowed: false,
  turn: { n: 3 },
  players: [
    { id: 'me', name: 'r', human: true, life: 40,
      manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, librarySize: 40, handSize: 1,
      battlefield: [{ ...card('perm1', 'Bear'), controllerId: 'me', tapped: false }],
      graveyard: [card('gy1', 'Dead Bear')], exile: [], commandZone: [] },
    { id: 'oppA', name: 'a', human: false, life: 40,
      manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, librarySize: 40, handSize: 0,
      battlefield: [], graveyard: [], exile: [], commandZone: [] },
  ],
  stack: [],
  me: { playerId: 'me', hand: [card('hand1', 'Held Bear')] },
};

const base = { t: 'game.prompt' as const, seq: 1, gameId: 'g1', promptId: 5, message: 'm' };
const targets = (over: Partial<Extract<Prompt, { kind: 'chooseTargets' }>>): Prompt =>
  ({ ...base, kind: 'chooseTargets', candidates: [], min: 1, max: 1, required: true, ...over } as Prompt);

describe('dockOwns', () => {
  it('T7 kinds never render in the dock', () => {
    expect(dockOwns({ ...base, kind: 'confirm' }, state)).toBe(false);
    expect(dockOwns({ ...base, kind: 'priority', playable: {}, canPass: true }, state)).toBe(false);
    expect(dockOwns({ ...base, kind: 'chooseAmount', min: 0, max: 9 }, state)).toBe(false);
  });

  it('unmigrated kinds stay in the dock', () => {
    expect(dockOwns({ ...base, kind: 'chooseOption', options: [{ key: 'k', text: 't' }] }, state)).toBe(true);
    expect(dockOwns({ ...base, kind: 'payMana', remaining: '{U}', canCancel: true }, state)).toBe(true);
  });

  it('chooseTargets with felt / hand / player candidates → canvas + cluster (T8)', () => {
    expect(dockOwns(targets({ candidates: ['perm1'] }), state)).toBe(false);
    expect(dockOwns(targets({ candidates: ['hand1', 'perm1'] }), state)).toBe(false);
    expect(dockOwns(targets({ candidates: ['oppA', 'me'] }), state)).toBe(false);   // "Select defender"
  });

  it('chooseTargets with a cards[] grid stays in the dock until the T9 carousel', () => {
    expect(dockOwns(targets({ candidates: ['x1'], cards: [card('x1', 'Library Pick')] }), state)).toBe(true);
  });

  it('pile-zone / unknown candidates stay in the dock (stranded buttons)', () => {
    expect(dockOwns(targets({ candidates: ['gy1'] }), state)).toBe(true);        // graveyard
    expect(dockOwns(targets({ candidates: ['perm1', 'mystery'] }), state)).toBe(true);
  });

  it('no state yet → dock (the safe side of the split)', () => {
    expect(dockOwns(targets({ candidates: ['perm1'] }), undefined)).toBe(true);
  });
});
