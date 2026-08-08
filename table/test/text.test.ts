// Rules-text normalization for the canvas panels (src/text.ts): entity decode,
// X back-out, X fill-in.

import { describe, expect, it } from 'vitest';
import { chosenX, decodeEntities, substituteX } from '../src/text';

describe('decodeEntities', () => {
  it('decodes named punctuation entities (the em dash that broke "Choose one —")', () => {
    expect(decodeEntities('Choose one &mdash;')).toBe('Choose one —');
    expect(decodeEntities('1 &ndash; 3')).toBe('1 – 3');
    expect(decodeEntities('&hellip;')).toBe('…');
    expect(decodeEntities('it&rsquo;s')).toBe('it’s');
  });

  it('decodes decimal and hex numeric entities', () => {
    expect(decodeEntities('a&#8212;b')).toBe('a—b');
    expect(decodeEntities('a&#x2014;b')).toBe('a—b');
  });

  it('remaps Windows-1252 numeric entities XMage emits from Swing HTML', () => {
    expect(decodeEntities('a&#151;b')).toBe('a—b');   // CP-1252 em dash, not U+0097
    expect(decodeEntities('a&#150;b')).toBe('a–b');   // CP-1252 en dash
  });

  it('leaves unknown entities and bare ampersands verbatim', () => {
    expect(decodeEntities('Fire & Ice')).toBe('Fire & Ice');
    expect(decodeEntities('&notareal;')).toBe('&notareal;');
  });
});

describe('chosenX', () => {
  it('backs the paid X out of a spell mana value (Fireball {X}{R} for 3)', () => {
    expect(chosenX('{X}{R}', 4)).toBe(3);   // 4 total − 1 fixed (R) = X of 3
  });

  it('handles a leading generic and X of 0', () => {
    expect(chosenX('{2}{X}{U}', 3)).toBe(0);   // 3 − (2 + 1) = 0
    expect(chosenX('{2}{X}{U}', 7)).toBe(4);
  });

  it('splits across a doubled X ({X}{X}{R} for 2 each)', () => {
    expect(chosenX('{X}{X}{R}', 5)).toBe(2);   // (5 − 1) / 2
  });

  it('is undefined without an X in the cost', () => {
    expect(chosenX('{2}{U}{U}', 4)).toBeUndefined();
    expect(chosenX(undefined, 3)).toBeUndefined();
  });

  it('is undefined when the arithmetic is not a clean non-negative integer', () => {
    expect(chosenX('{X}{X}{R}', 4)).toBeUndefined();   // (4 − 1)/2 = 1.5
    expect(chosenX('{X}{R}', 0)).toBeUndefined();       // −1
  });
});

describe('substituteX', () => {
  it('fills the value into a cost token and standalone variables', () => {
    expect(substituteX('{X}: deal X damage', 3)).toBe('{3}: deal 3 damage');
    expect(substituteX('a X/X token', 2)).toBe('a 2/2 token');
  });

  it('never touches an X inside a word', () => {
    expect(substituteX('exile and Xerox', 5)).toBe('exile and Xerox');
  });
});
