// Mana-cost string parsing ("{2}{U}{U}", "{1}{B/P}{B/P}", "{X}") → symbol
// tokens for the ManaSymbols renderer and the payMana dock. Pure string work;
// no card DB (protocol §1).

export type ManaSymbol = string;   // the braces' content: "2", "U", "B/P", "X", "W/U", "S", "T"

export function parseManaCost(cost: string | undefined): ManaSymbol[] {
  if (cost === undefined || cost === '') return [];
  const out: ManaSymbol[] = [];
  const re = /\{([^{}]+)\}/g;
  for (let m = re.exec(cost); m !== null; m = re.exec(cost)) out.push(m[1]!);
  return out;
}

/** The W/U/B/R/G/C a symbol is colored as, or undefined for generic/X/snow.
 *  Hybrids return their first colored half — enough for a background tint. */
export function symbolColor(sym: ManaSymbol): 'W' | 'U' | 'B' | 'R' | 'G' | 'C' | undefined {
  for (const part of sym.split('/')) {
    if (part === 'W' || part === 'U' || part === 'B' || part === 'R' || part === 'G' || part === 'C') return part;
  }
  return undefined;
}
