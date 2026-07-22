// Deck-text → image-warm identities (C5, design §9). The .dck trap: LAYOUT
// lines repeat every [SET:NUM] identity, so a whole-text scan double-counts.
// Three syntaxes now, matching what the bridge sniffs: .dck, .moxfield, .mtgo.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDeckIdentities } from '../src/images/deck';

const fixture = (name: string): string => fs.readFileSync(
  fileURLToPath(new URL(`../../../bridge/src/test/resources/decks/${name}`, import.meta.url)), 'utf8');

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

  describe('.moxfield lines', () => {
    it('parses name (SET) NUM and strips the foil marker', () => {
      const out = parseDeckIdentities('1 Rose Tyler (WHO) 5 *F*\n1 Adipose Offspring (WHO) 10\n');
      expect(out).toEqual([
        { set: 'WHO', number: '5', name: 'Rose Tyler' },
        { set: 'WHO', number: '10', name: 'Adipose Offspring' },
      ]);
    });

    it('keeps a split-card name whole', () => {
      expect(parseDeckIdentities('1 Coward / Killer (WHO) 77\n')).toEqual([
        { set: 'WHO', number: '77', name: 'Coward / Killer' },
      ]);
    });

    it('skips section headers such as PLANES: and SIDEBOARD:', () => {
      const out = parseDeckIdentities('PLANES:\n1 Ood Sphere (WHO) 594\nSIDEBOARD:\n');
      expect(out).toEqual([{ set: 'WHO', number: '594', name: 'Ood Sphere' }]);
    });

    it('warms a whole real Moxfield export with printings on every identity', () => {
      const out = parseDeckIdentities(fixture('timey_wimey.moxfield'));
      expect(out.length).toBeGreaterThan(90);
      expect(out.every(c => c.set !== '' && c.number !== '')).toBe(true);
      expect(out).toContainEqual({ set: 'WHO', number: '5', name: 'Rose Tyler' });
      expect(out).toContainEqual({ set: 'WHO', number: '264', name: 'Command Tower' });
    });
  });

  describe('.mtgo lines', () => {
    it('warms name-only lines with an empty set and number', () => {
      expect(parseDeckIdentities('1 Adipose Offspring\n4 Command Tower\n')).toEqual([
        { set: '', number: '', name: 'Adipose Offspring' },
        { set: '', number: '', name: 'Command Tower' },
      ]);
    });

    it('dedupes name-only identities by name', () => {
      expect(parseDeckIdentities('1 Forest\n1 Forest\n1 forest\n')).toHaveLength(1);
    });

    it('does not collapse two different names onto one empty printing', () => {
      expect(parseDeckIdentities('1 Island\n1 Forest\n')).toHaveLength(2);
    });

    it('warms a whole real MTGO list, including the trailing commander stanza', () => {
      const out = parseDeckIdentities(fixture('timey_wimey.mtgo'));
      expect(out.length).toBeGreaterThan(90);
      expect(out.every(c => c.set === '' && c.number === '')).toBe(true);
      expect(out).toContainEqual({ set: '', number: '', name: 'Rose Tyler' });
      expect(out).toContainEqual({ set: '', number: '', name: 'The Tenth Doctor' });
    });
  });
});
