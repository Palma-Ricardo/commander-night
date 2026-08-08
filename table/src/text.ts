// Rules-text normalization for the table client, shared by both render seams —
// the DOM chrome (ManaSymbols) and the on-canvas panels (render/richtext). XMage
// sends Swing-flavored HTML; the bridge strips the tags and the handful of
// entities it emits (translate/Html.java), but the punctuation entities that ride
// through in card rules survive — the em dash in "Choose one —" most visibly.
// Decode the rest here, at the render seam, split `{…}` mana/symbol tokens out for
// pip rendering, and back out the chosen value of X for a spell on the stack so
// its text reads "deals 3 damage", not "deals X damage".
//
// (Table-local rather than in @night/core because this worktree resolves the
// shared package to the main checkout — only its committed API, e.g.
// parseManaCost, is reachable from here.)

import { parseManaCost } from '@night/core/state/mana';

/** One piece of a decoded rules string: a run of plain text, or a single `{…}`
 *  mana/symbol token (the brace content — "G", "2", "W/U", "T", "X", "S"). */
export interface SymbolPart {
  kind: 'text' | 'pip';
  value: string;
}

/** Split a string on its `{…}` symbol tokens into text/pip parts — the pure core
 *  shared by every pip renderer (the DOM `manaNodes` and the canvas `tokenize`),
 *  so "{T}: Add {G}" reads as pips everywhere, never raw braces. A fresh regex per
 *  call: a shared `/g` instance would carry `lastIndex` across calls. */
export function splitSymbols(chunk: string): SymbolPart[] {
  const re = /\{([^{}]+)\}/g;
  const parts: SymbolPart[] = [];
  let last = 0;
  for (let m = re.exec(chunk); m !== null; m = re.exec(chunk)) {
    if (m.index > last) parts.push({ kind: 'text', value: chunk.slice(last, m.index) });
    parts.push({ kind: 'pip', value: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < chunk.length) parts.push({ kind: 'text', value: chunk.slice(last) });
  return parts;
}

// The named entities XMage's card text actually carries past the bridge's strip —
// mostly punctuation. Kept small and explicit (protocol §8: not a general parser),
// but the numeric branch below covers anything not listed here.
const NAMED_ENTITIES: Record<string, string> = {
  mdash: '—', ndash: '–', minus: '−', hellip: '…',
  bull: '•', middot: '·', times: '×', divide: '÷',
  deg: '°', nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  frac12: '½', infin: '∞',
};

// XMage's Swing HTML sometimes emits Windows-1252 code points as raw numeric
// entities (&#151; is that charset's em dash, not the C1 control at U+0097). Map
// the punctuation ones back to their Unicode equivalents so they render.
const CP1252: Record<number, string> = {
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”',
  0x95: '•', 0x96: '–', 0x97: '—', 0x85: '…',
};

/** Decode the HTML entities that survive the bridge's tag strip — named
 *  (`&mdash;`), decimal (`&#8212;`) and hex (`&#x2014;`) — so special characters
 *  render as themselves. Unknown entities are left verbatim (never blanked). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp)) return m;
      if (CP1252[cp] !== undefined) return CP1252[cp]!;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return m;
      }
    }
    const v = NAMED_ENTITIES[body];
    return v !== undefined ? v : m;
  });
}

/** The mana value a single cost symbol contributes with X treated as 0 (rule
 *  202.3e, off the stack): numeric generic tokens carry their number, X/Y/Z are
 *  0, and every coloured/hybrid/Phyrexian/snow pip is 1 (a hybrid's numeric half,
 *  e.g. {2/W}, counts as that number). */
function symbolManaValue(sym: string): number {
  if (sym === 'X' || sym === 'Y' || sym === 'Z') return 0;
  const n = Number(sym);
  if (Number.isFinite(n)) return n;
  const nums = sym.split('/').map(Number).filter(x => Number.isFinite(x));
  return nums.length > 0 ? Math.max(...nums) : 1;
}

/** The chosen value of X for a spell on the stack, backed out of its reported
 *  mana value. Per rule 202.3e a spell's mana value counts X at its chosen number
 *  *while on the stack*, so `manaValue − fixedCost` divided by the number of {X}
 *  in the cost is the X that was paid. Undefined when the cost carries no X, or
 *  the arithmetic doesn't land on a clean non-negative integer (an exotic cost we
 *  don't model — then we leave the literal X rather than guess). */
export function chosenX(manaCost: string | undefined, manaValue: number): number | undefined {
  const syms = parseManaCost(manaCost);
  const nx = syms.filter(s => s === 'X').length;
  if (nx === 0) return undefined;
  const fixed = syms.reduce((sum, s) => sum + symbolManaValue(s), 0);
  const x = (manaValue - fixed) / nx;
  return Number.isInteger(x) && x >= 0 ? x : undefined;
}

/** Fill a spell's chosen X into a line of its rules text: `{X}` in a cost becomes
 *  the paid generic (`{3}`), and a standalone `X` variable (as in "deals X damage"
 *  or a "X/X" token) becomes the number. Word-boundaried so it never touches an X
 *  inside another word. */
export function substituteX(line: string, x: number): string {
  return line.replace(/\{X\}/g, `{${x}}`).replace(/\bX\b/g, String(x));
}
