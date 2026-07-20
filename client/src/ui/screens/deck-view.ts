// Per-seat deck verdict, lobby.state → view model (protocol §5). Pure — the
// seat row is a thin shell over this.
//
// Two rules here are contract, not presentation:
//
// 1. Every optional array in §5 is empty-means-absent: the bridge never sends
//    [], so a missing key and an empty array must read identically. Normalising
//    once here keeps every call site off `?.length ? … : …`.
//
// 2. `commanders` is carried as one entry per name and is populated whether or
//    not the deck is valid. Moxfield's export does not mark commanders, so the
//    bridge infers them from deck position and card abilities, and a false
//    positive — a maindeck card carrying a partner-style ability promoted into a
//    second commander slot — still passes every legality check: 101 cards,
//    valid:true, the wrong general. §5 makes echoing the names the whole
//    mitigation and requires clients to render each name, not a summary. Hiding
//    them behind `valid` would blank them on precisely the decks most likely to
//    be misread, so `kind` and `commanders` are independent.

import type { LobbyState } from '../../protocol/protocol';

type SeatDeck = NonNullable<LobbyState['seats'][number]['deck']>;

export interface DeckView {
  kind: 'none' | 'valid' | 'invalid';
  cards: number;
  /** Absent only when the text was rejected before a syntax was established (§5). */
  format?: SeatDeck['format'];
  /** One entry per detected commander. Never joined, never truncated. */
  commanders: string[];
  /** Fatal — the seat cannot ready. Never empty when `kind` is 'invalid'. */
  problems: string[];
  /** Advisory; the deck is startable. Own seat only — these name specific cards. */
  warnings: string[];
}

export function deckView(deck: SeatDeck | undefined, opts: { own: boolean }): DeckView {
  if (deck === undefined) {
    return { kind: 'none', cards: 0, commanders: [], problems: [], warnings: [] };
  }
  return {
    kind: deck.valid ? 'valid' : 'invalid',
    cards: deck.cards,
    ...(deck.format !== undefined ? { format: deck.format } : {}),
    commanders: deck.commander ?? [],
    // A deck can only be un-startable for a reason; if the bridge names none we
    // still have to say something, or the row reads as merely quiet.
    problems: deck.valid ? [] : (deck.problems?.length ? deck.problems : ['deck invalid']),
    // An opponent's list is hidden information (design §9) and warnings quote it
    // card by card. Commanders above are public — they start in the command zone.
    warnings: opts.own ? deck.warnings ?? [] : [],
  };
}
