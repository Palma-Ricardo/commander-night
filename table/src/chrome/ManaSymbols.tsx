// Mana symbols as coloured pips. Every symbol that has a bundled SVG in
// src/assets/mana/ or src/assets/misc/ renders as <img>; anything else (a
// genuinely unknown token) falls back to a tinted disc with the value as text.
// The SVG filename is derived from the brace content by stripping slashes:
// "W/U" → WU.svg, "2/W" → 2W.svg, "B/P" → BP.svg, "W/U/P" → WUP.svg.
// `ManaText`/`manaNodes` render a plain string with its `{…}` tokens turned
// into pips, for prompt messages and log lines (§8) — "{G}" reads as a pip.

import type { ReactNode } from 'react';
import { parseManaCost, symbolColor, type ManaSymbol } from '@night/core/state/mana';
import { splitSymbols } from '../text';
import tSym from '../assets/misc/T.svg';

// Eagerly load every SVG in assets/mana/; key = filename without extension.
const _manaGlob = import.meta.glob<string>('../assets/mana/*.svg', { eager: true, import: 'default' });
const MANA_SVG: Record<string, string> = Object.fromEntries(
  Object.entries(_manaGlob).map(([p, url]) => [p.slice(p.lastIndexOf('/') + 1, -4), url])
);

function ManaPip({ sym }: { sym: ManaSymbol }) {
  const key = sym.replace(/\//g, '');
  const src = key === 'T' ? tSym : MANA_SVG[key];
  if (src !== undefined) return <img className="mana-img" src={src} alt={sym} draggable={false} />;
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
