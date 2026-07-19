// Pile browser ordering + filtering (C5). A 40-card graveyard is a wall
// scanned by eye without these.

import { describe, expect, it } from 'vitest';
import { filterSortPile } from '../src/ui/board/pile';
import type { Card } from '../src/protocol/protocol';

const card = (name: string, types: string[], manaValue: number): Card =>
  ({
    id: name, name, set: 'X', number: '1', manaValue, types,
    subtypes: [], supertypes: [], colors: [], text: [],
  } as unknown as Card);

const names = (cards: Card[]) => cards.map(c => c.name);

describe('filterSortPile', () => {
  it('orders by type rank, then mana value, then name', () => {
    const pile = [
      card('Forest', ['LAND'], 0),
      card('Shock', ['INSTANT'], 1),
      card('Bear', ['CREATURE'], 2),
      card('Ant', ['CREATURE'], 2),
      card('Bird', ['CREATURE'], 1),
    ];
    expect(names(filterSortPile(pile, ''))).toEqual(
      ['Bird', 'Ant', 'Bear', 'Shock', 'Forest'],
    );
  });

  it('filters on name, case-insensitively', () => {
    const pile = [card('Agitator Ant', ['CREATURE'], 2), card('Forest', ['LAND'], 0)];
    expect(names(filterSortPile(pile, 'ant'))).toEqual(['Agitator Ant']);
    expect(names(filterSortPile(pile, 'FOR'))).toEqual(['Forest']);
  });

  it('treats an empty or whitespace filter as no filter', () => {
    const pile = [card('Forest', ['LAND'], 0), card('Bear', ['CREATURE'], 2)];
    expect(filterSortPile(pile, '   ')).toHaveLength(2);
  });

  it('ranks unknown types last without dropping them', () => {
    const pile = [card('Weird', ['CONSPIRACY'], 0), card('Bear', ['CREATURE'], 2)];
    expect(names(filterSortPile(pile, ''))).toEqual(['Bear', 'Weird']);
  });

  it('does not mutate the input array', () => {
    const pile = [card('Forest', ['LAND'], 0), card('Bear', ['CREATURE'], 2)];
    const before = names(pile);
    filterSortPile(pile, '');
    expect(names(pile)).toEqual(before);
  });
});
