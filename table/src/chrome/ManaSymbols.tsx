// Mana symbols as coloured pips. The WUBRG(C) symbols are the bundled SVGs
// (src/assets/mana/{W,U,B,R,G,C}.svg) — complete pips with the coloured disc and
// glyph baked in, so we just drop them in as <img>. Everything without a dedicated
// symbol — generic {2}, {X}, hybrids, {T}/{S} — falls back to the text pip it
// always was (a tinted disc with the value). `ManaText`/`manaNodes` render a plain
// string with its `{…}` tokens turned into pips, for the prompt message and log
// lines (which arrive as text, §8) — so "{G}" reads as a pip, not braces.

import type { ReactNode } from 'react';
import { parseManaCost, symbolColor, type ManaSymbol } from '@night/core/state/mana';
import { splitSymbols } from '../text';
import wSym from '../assets/mana/W.svg';
import uSym from '../assets/mana/U.svg';
import bSym from '../assets/mana/B.svg';
import rSym from '../assets/mana/R.svg';
import gSym from '../assets/mana/G.svg';
import cSym from '../assets/mana/C.svg';

// The pure single-mana symbols that own a real pip (WUBRG + colourless C).
const SYMBOL: Partial<Record<ManaSymbol, string>> =
  { W: wSym, U: uSym, B: bSym, R: rSym, G: gSym, C: cSym };

function ManaPip({ sym }: { sym: ManaSymbol }) {
  const src = SYMBOL[sym];
  if (src !== undefined) return <img className="mana-img" src={src} alt={sym} draggable={false} />;
  // generic / X / hybrid / tap / snow — the disc tints to the first colour, the
  // text carries the value (a two-colour hybrid disc is not worth the complexity).
  return <span className={`mana mana-${symbolColor(sym) ?? 'X'}`}>{sym}</span>;
}

export function ManaSymbols({ cost, symbols }: { cost?: string; symbols?: ManaSymbol[] }) {
  const syms = symbols ?? parseManaCost(cost);
  if (syms.length === 0) return null;
  return (
    <span className="mana-cost">
      {syms.map((s, i) => <ManaPip key={i} sym={s} />)}
    </span>
  );
}

/** Split a string on its `{…}` mana tokens, rendering each as a pip and the rest
 *  as plain text. Tokenized by the shared `splitSymbols` — the same split the
 *  canvas pip renderer uses, so prose reads identically in DOM and on the felt. */
export function manaNodes(text: string): ReactNode[] {
  return splitSymbols(text).map((part, i) =>
    part.kind === 'pip'
      ? <ManaPip key={`m${i}`} sym={part.value} />
      : part.value);
}

/** A string with its `{…}` mana tokens rendered as pips inline (prompt/log copy). */
export function ManaText({ text }: { text: string }) {
  return <>{manaNodes(text)}</>;
}
