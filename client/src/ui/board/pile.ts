// Pile browser ordering + filtering (C5). Graveyards and exile arrive in game
// order, which is the wrong order for finding a card: scan order is type, then
// cost, then name. Pure — the modal is a thin shell over this.

import type { Card } from '../../protocol/protocol';

// Card.types is uppercase on the wire (protocol §1: "CREATURE, INSTANT, …").
const TYPE_RANK = [
  'CREATURE', 'PLANESWALKER', 'INSTANT', 'SORCERY',
  'ARTIFACT', 'ENCHANTMENT', 'BATTLE', 'LAND',
];

function rankOf(card: Card): number {
  for (let i = 0; i < TYPE_RANK.length; i++) {
    if (card.types.includes(TYPE_RANK[i]!)) return i;
  }
  return TYPE_RANK.length;   // unknown types sort last, never dropped
}

export function filterSortPile(cards: Card[], filter: string): Card[] {
  const needle = filter.trim().toLowerCase();
  const kept = needle === ''
    ? [...cards]
    : cards.filter(c => c.name.toLowerCase().includes(needle));
  return kept.sort((a, b) =>
    rankOf(a) - rankOf(b)
    || a.manaValue - b.manaValue
    || a.name.localeCompare(b.name));
}
