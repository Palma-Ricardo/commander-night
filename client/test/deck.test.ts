// Deck-text → image-warm identities (C5, design §9). The .dck trap: LAYOUT
// lines repeat every [SET:NUM] identity, so a whole-text scan double-counts.

import { describe, expect, it } from 'vitest';
import { parseDeckIdentities } from '../src/images/deck';

describe('parseDeckIdentities', () => {
  it('parses main-deck lines into set/number/name', () => {
    const out = parseDeckIdentities('1 [MKC:145] Agitator Ant\n1 [NEC:18] Akki Battle Squad\n');
    expect(out).toEqual([
      { set: 'MKC', number: '145', name: 'Agitator Ant' },
      { set: 'NEC', number: '18', name: 'Akki Battle Squad' },
    ]);
  });

  it('includes the SB: line — in Commander that is the commander', () => {
    const out = parseDeckIdentities('SB: 1 [NEC:1] Chishiro, the Shattered Blade\n');
    expect(out).toEqual([{ set: 'NEC', number: '1', name: 'Chishiro, the Shattered Blade' }]);
  });

  it('skips LAYOUT metadata lines', () => {
    const text = '1 [MKC:145] Agitator Ant\n'
      + 'LAYOUT MAIN:(1,1)(NONE,false,50)|([MKC:145],[NEC:18],[ELD:331])\n'
      + 'LAYOUT SIDEBOARD:(1,1)(NONE,false,50)|([NEC:1])\n';
    expect(parseDeckIdentities(text)).toEqual([
      { set: 'MKC', number: '145', name: 'Agitator Ant' },
    ]);
  });

  it('dedupes repeated identities (basics appear many times)', () => {
    const text = '1 [HOB:198] Forest\n1 [HOB:198] Forest\n1 [HOB:198] Forest\n';
    expect(parseDeckIdentities(text)).toHaveLength(1);
  });

  it('ignores blank, whitespace, and malformed lines', () => {
    const text = '\n   \n1 [MKC:145] Agitator Ant\nnot a card line\n1 [BAD] Missing Colon\n';
    expect(parseDeckIdentities(text)).toEqual([
      { set: 'MKC', number: '145', name: 'Agitator Ant' },
    ]);
  });

  it('handles quantities greater than one and surrounding whitespace', () => {
    expect(parseDeckIdentities('  12 [HOB:197] Mountain  \n')).toEqual([
      { set: 'HOB', number: '197', name: 'Mountain' },
    ]);
  });
});
