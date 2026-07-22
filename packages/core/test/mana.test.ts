// Mana-cost parsing (state/mana.ts).

import { describe, expect, it } from 'vitest';
import { parseManaCost, symbolColor } from '../src/state/mana';

describe('parseManaCost', () => {
  it('parses plain costs', () => {
    expect(parseManaCost('{2}{U}{U}')).toEqual(['2', 'U', 'U']);
  });

  it('parses hybrid and Phyrexian symbols', () => {
    expect(parseManaCost('{1}{B/P}{B/P}')).toEqual(['1', 'B/P', 'B/P']);
    expect(parseManaCost('{W/U}{X}')).toEqual(['W/U', 'X']);
  });

  it('handles empty/absent costs', () => {
    expect(parseManaCost(undefined)).toEqual([]);
    expect(parseManaCost('')).toEqual([]);
  });
});

describe('symbolColor', () => {
  it('colors plain and hybrid symbols', () => {
    expect(symbolColor('U')).toBe('U');
    expect(symbolColor('B/P')).toBe('B');
    expect(symbolColor('W/U')).toBe('W');
    expect(symbolColor('C')).toBe('C');
  });

  it('generic and X are uncolored', () => {
    expect(symbolColor('2')).toBeUndefined();
    expect(symbolColor('X')).toBeUndefined();
    expect(symbolColor('S')).toBeUndefined();
  });
});
