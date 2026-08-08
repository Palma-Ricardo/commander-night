// The pure tokenize/wrap core of the ability-panel rich-text renderer
// (render/richtext.ts). The PIXI glue that measures + draws needs a canvas and is
// exercised by `npm run shoot`; here we pin the word-splitting and wrapping.

import { describe, expect, it } from 'vitest';
import { tokenize, wrapLines, type Word } from '../src/render/richtext';

describe('tokenize', () => {
  it('splits a mana token out as its own pip part, text around it as text', () => {
    expect(tokenize('Add {G}')).toEqual([
      [{ kind: 'text', value: 'Add' }],
      [{ kind: 'pip', value: 'G' }],
    ]);
  });

  it('keeps a pip and its trailing punctuation in one word', () => {
    expect(tokenize('{T}: draw')).toEqual([
      [{ kind: 'pip', value: 'T' }, { kind: 'text', value: ':' }],
      [{ kind: 'text', value: 'draw' }],
    ]);
  });

  it('collapses runs of whitespace and drops empties', () => {
    expect(tokenize('a   b')).toEqual([
      [{ kind: 'text', value: 'a' }],
      [{ kind: 'text', value: 'b' }],
    ]);
  });
});

const word = (w: number): Word => ({ parts: [{ kind: 'text', value: 'x', w }], w });

describe('wrapLines', () => {
  it('packs words up to the width, then breaks', () => {
    const lines = wrapLines([word(40), word(40), word(40)], 100, 10);
    // 40 + 10 + 40 = 90 ≤ 100 fits; adding a third (140) overflows → new line.
    expect(lines.map(l => l.length)).toEqual([2, 1]);
  });

  it('gives an over-wide word its own line rather than looping', () => {
    const lines = wrapLines([word(200), word(30)], 100, 10);
    expect(lines.map(l => l.length)).toEqual([1, 1]);
  });

  it('returns no lines for no words', () => {
    expect(wrapLines([], 100, 10)).toEqual([]);
  });
});
