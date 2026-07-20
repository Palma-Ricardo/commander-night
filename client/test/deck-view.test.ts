// Lobby per-seat deck verdict view model (protocol §5).
//
// The load-bearing case is the commander list. Moxfield's export does not mark
// commanders, so the bridge INFERS them, and a false positive (a maindeck card
// carrying a partner-style ability promoted into a second commander slot) still
// passes every legality check — 101 cards, valid:true, wrong commander. §5 makes
// echoing the names the mitigation and requires clients to "render each name, not
// a summary". So: one element per name, and present on invalid decks too, since a
// bad inference is exactly what an invalid deck is likely to be reporting.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decode } from '../src/protocol/codec';
import type { LobbyState } from '../src/protocol/protocol';
import { deckView } from '../src/ui/screens/deck-view';

// Decoded dev-strict, so this test also fails if the sample ever grows a field
// the codec does not know about.
const sample = (name: string): LobbyState => {
  const raw = fs.readFileSync(
    fileURLToPath(new URL(`../../docs/protocol/samples/${name}`, import.meta.url)), 'utf8');
  const r = decode(raw, { strict: true });
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  if (r.msg === null || r.msg.t !== 'lobby.state') throw new Error(`${name}: not a lobby.state`);
  return r.msg;
};

type Deck = NonNullable<LobbyState['seats'][number]['deck']>;

describe('deckView', () => {
  it('reads the corpus deck-warnings sample: format, count, both commanders, warnings', () => {
    const seat = sample('lobby.state.deck-warnings.json').seats[0]!;
    expect(deckView(seat.deck, { own: true })).toEqual({
      kind: 'valid',
      cards: 100,
      format: 'moxfield',
      commanders: ['Rose Tyler', 'The Tenth Doctor'],
      problems: [],
      warnings: [
        'ignored 10 cards in section PLANES:',
        'Aura of Silence — no PLST:C15-60 printing, used C15:60',
      ],
    });
  });

  it('keeps commanders as one element per name — never a joined summary', () => {
    const view = deckView(
      { valid: true, cards: 100, commander: ['Rose Tyler', 'The Tenth Doctor'] }, { own: true });
    expect(view.commanders).toHaveLength(2);
    expect(view.commanders).toEqual(['Rose Tyler', 'The Tenth Doctor']);
  });

  // The mitigation is worthless if it disappears on the decks most likely to be
  // wrong: an invalid deck must still show what the bridge thought the commanders
  // were, alongside the problems.
  it('still reports commanders when the deck is invalid', () => {
    const deck: Deck = {
      valid: false,
      cards: 101,
      format: 'moxfield',
      commander: ['The Fifteenth Doctor', 'Agitator Ant'],
      problems: ['Deck contains 101 maindeck cards, expected 99'],
    };
    const view = deckView(deck, { own: true });
    expect(view.kind).toBe('invalid');
    expect(view.commanders).toEqual(['The Fifteenth Doctor', 'Agitator Ant']);
    expect(view.problems).toEqual(['Deck contains 101 maindeck cards, expected 99']);
  });

  it('treats absent optional arrays as empty (§5: the bridge never sends [])', () => {
    expect(deckView({ valid: true, cards: 100 }, { own: true })).toEqual({
      kind: 'valid', cards: 100, commanders: [], problems: [], warnings: [],
    });
  });

  it('omits format when the text was rejected before a syntax was established', () => {
    const view = deckView({ valid: false, cards: 0, problems: ['unrecognised deck format'] },
      { own: true });
    expect(view.format).toBeUndefined();
    expect('format' in view).toBe(false);
  });

  it('falls back to a generic problem when an invalid deck names none', () => {
    expect(deckView({ valid: false, cards: 0 }, { own: true }).problems).toEqual(['deck invalid']);
  });

  // Warnings name specific cards in the list; an opponent's list is hidden
  // information (design §9). Commanders are not — they start in the command zone.
  it("hides warnings on other players' seats but keeps their commanders", () => {
    const deck: Deck = {
      valid: true, cards: 100, format: 'moxfield',
      commander: ['Rose Tyler', 'The Tenth Doctor'],
      warnings: ['ignored 10 cards in section PLANES:'],
    };
    expect(deckView(deck, { own: false })).toEqual({
      kind: 'valid', cards: 100, format: 'moxfield',
      commanders: ['Rose Tyler', 'The Tenth Doctor'],
      problems: [], warnings: [],
    });
  });

  // Problems quote card names and raw deck lines just as specifically as
  // warnings do, so they get the same off-seat redaction — an opponent sees
  // only that the deck is invalid, never why.
  it("redacts problem detail on other players' seats but keeps it on the own seat", () => {
    const deck: Deck = {
      valid: false, cards: 101, format: 'moxfield',
      commander: ['Rose Tyler', 'The Tenth Doctor'],
      problems: ["line 12: no such card: Thassa's Oracle"],
    };
    expect(deckView(deck, { own: false })).toEqual({
      kind: 'invalid', cards: 101, format: 'moxfield',
      commanders: ['Rose Tyler', 'The Tenth Doctor'],
      problems: ['deck invalid'], warnings: [],
    });
    expect(deckView(deck, { own: true })).toEqual({
      kind: 'invalid', cards: 101, format: 'moxfield',
      commanders: ['Rose Tyler', 'The Tenth Doctor'],
      problems: ["line 12: no such card: Thassa's Oracle"], warnings: [],
    });
  });

  it('reports a seat with no deck yet', () => {
    expect(deckView(undefined, { own: true })).toEqual({
      kind: 'none', cards: 0, commanders: [], problems: [], warnings: [],
    });
  });
});
