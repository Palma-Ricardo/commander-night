// Deck text → card identities, for the C5 image cache warm-up (design §9).
//
// Three syntaxes, matching what the bridge sniffs (protocol §5):
//   1 [MKC:145] Agitator Ant           .dck        set + number
//   1 Agitator Ant (MKC) 145 *F*       .moxfield   set + number, foil marker stripped
//   1 Agitator Ant                     .mtgo       name only
//
// .mtgo lines carry no printing, so they warm by name alone: the resolver's
// lookup ladder already falls back to /cards/named?exact= when number is ''.
// The bridge picks the actual printing, so a name-warmed image may differ from
// the one dealt — warm-up is optional and cosmetic either way, which is also
// why over-warming (e.g. a discarded PLANES: section the bridge drops) is fine.
//
// The .dck LAYOUT lines repeat every identity in the deck, so this parses line
// by line and skips them: a whole-text regex scan would yield the deck twice.
// Identities also repeat legitimately (nine copies of [HOB:198]), so the result
// is deduped — on set/number where there is a printing, on the name where there
// is not, since every .mtgo line would otherwise collide on the same empty key.

import type { CardIdentity } from './scryfall';

const DCK_LINE = /^(?:SB:\s*)?\d+\s+\[([^:\]]+):([^\]]*)\]\s+(.+?)$/;
const MOX_LINE = /^\d+\s+(.+?)\s+\(([^)]+)\)\s+(\S+?)(?:\s+\*\w+\*)*$/;
const MTGO_LINE = /^\d+\s+(.+?)$/;
const SECTION = /^[A-Za-z][A-Za-z ]*:$/;

// The name-only rung is the last resort and matches almost anything after a
// count, so it must not silently adopt a *malformed* printing line: brackets are
// .dck's syntax, and a bracketed line DCK_LINE already rejected is a broken line,
// not a card called "[BAD] Missing Colon".
const PRINTING_DEBRIS = /[[\]]/;

export function parseDeckIdentities(text: string): CardIdentity[] {
  const out: CardIdentity[] = [];
  const seen = new Set<string>();
  const push = (set: string, number: string, rawName: string): void => {
    const name = rawName.trim();
    if (name === '') return;
    const key = number === '' ? `/${name.toLowerCase()}` : `${set.toLowerCase()}/${number}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ set, number, name });
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('LAYOUT') || SECTION.test(line)) continue;
    const dck = DCK_LINE.exec(line);
    if (dck !== null) {
      const [, set, number, name] = dck as unknown as [string, string, string, string];
      push(set, number, name);
      continue;
    }
    const mox = MOX_LINE.exec(line);
    if (mox !== null) {
      const [, name, set, number] = mox as unknown as [string, string, string, string];
      push(set, number, name);
      continue;
    }
    const mtgo = MTGO_LINE.exec(line);
    if (mtgo !== null) {
      const [, name] = mtgo as unknown as [string, string];
      if (!PRINTING_DEBRIS.test(name)) push('', '', name);
    }
  }
  return out;
}
