// Mana symbols as styled spans — hand-rolled (no external symbol font, §1).

import { parseManaCost, symbolColor, type ManaSymbol } from '@night/core/state/mana';

export function ManaSymbols({ cost, symbols }: { cost?: string; symbols?: ManaSymbol[] }) {
  const syms = symbols ?? parseManaCost(cost);
  if (syms.length === 0) return null;
  return (
    <span className="mana-cost">
      {syms.map((s, i) => (
        <span key={i} className={`mana mana-${symbolColor(s) ?? 'X'}`}>{s}</span>
      ))}
    </span>
  );
}
