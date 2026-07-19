// Deck text → card identities, for the C5 image cache warm-up (design §9).
//
// XMage .dck lines:
//   1 [MKC:145] Agitator Ant           main deck
//   SB: 1 [NEC:1] Chishiro, ...        sideboard — the commander, in Commander
//   LAYOUT MAIN:(…)|([MKC:145],…)      trailing layout metadata
//
// The LAYOUT lines repeat every identity in the deck, so this parses line by
// line and skips them: a whole-text regex scan would yield the deck twice.
// Identities also repeat legitimately (nine copies of [HOB:198]), so the
// result is deduped on the resolver's own set/number identity.

import type { CardIdentity } from './scryfall';

const CARD_LINE = /^(?:SB:\s*)?\d+\s+\[([^:\]]+):([^\]]*)\]\s+(.+?)$/;

export function parseDeckIdentities(text: string): CardIdentity[] {
  const out: CardIdentity[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('LAYOUT')) continue;
    const m = CARD_LINE.exec(line);
    if (m === null) continue;
    const [, set, number, name] = m as unknown as [string, string, string, string];
    const key = `${set.toLowerCase()}/${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ set, number, name: name.trim() });
  }
  return out;
}
