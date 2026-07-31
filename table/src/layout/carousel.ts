// The carousel browser (prompts-on-the-table §4.4), pure and headless: what it
// shows (`carouselContent`) and where each card sits (`layoutCarouselStrip`).
// The scene renders the result as screen-space CardActors one band above the
// hand, and the DOM bar (chrome/CarouselBar) renders the title/filter/seek
// chrome from the same content, so canvas and chrome can never disagree about
// what is open or where along it you are.
//
// Amended 2026-07-30 by Issues.txt #8/#14: it is a **flat strip you scroll**,
// not a paged fan. The fan curve and the ◀ ▶ page buttons both went — the curve
// because that vocabulary means "held cards, yours" and wearing it here made a
// graveyard read like a second hand, the pages because they cut a scan into
// arbitrary blocks of nine when the natural gesture for a long row is to push
// it. Every mode now also takes a name filter, which only browse had. The strip
// runs through a ten-card window with dissolving ends, not across the whole
// felt: a row you can take in at a glance, which scrolling actually changes.
//
// Three clients of one surface:
//  • Prompt mode — a chooseTargets whose candidates the felt can't offer: a
//    `cards[]` grid (library looks, an opponent's graveyard pick) or candidate
//    ids outside this seat's view (§5.2 / §13 no-dead-end). Auto-opens; server
//    candidate order is preserved (reordering a choice list would be lying —
//    Modal.tsx's rule, kept, which is why the filter here only hides). Closes
//    only with its prompt.
//  • Reveal mode — §6 revealed/lookedAt windows, ambient, leaving by patch.
//  • Browse mode — a clicked graveyard/exile pile, read-only, with the scan
//    ordering + name filter from pile.ts. A pending prompt-mode ask *wins* over
//    an open browse; the browse reappears when the ask clears.

import type { Card, GameState, Id } from '@night/core';
import { unreachableCandidates } from '@night/core/state/selectors';
import type { PromptStoreState } from '@night/core/stores/prompt';
import { handBandHeight } from './screen';
import { filterSortPile } from './pile';
import type { ActorPlacement, Size } from './types';

export type BrowseZone = 'graveyard' | 'exile';
export interface BrowseRef { playerId: Id; zone: BrowseZone }

export interface CarouselEntry {
  id: Id;
  /** Undefined for a candidate the state can't resolve to a card — the scene
   *  renders the label on a text-frame placeholder; the click still answers. */
  card: Card | undefined;
  label: string;
}

export interface CarouselContent {
  mode: 'prompt' | 'reveal' | 'browse';
  /** Identity for scroll/filter reset: a new key starts back at offset 0 with a
   *  clean needle. */
  key: string;
  title: string;
  /** What is shown — after the name filter. */
  entries: CarouselEntry[];
  /** How many there were before filtering. Drives "n of m" and whether the bar
   *  offers a filter at all (a three-card look does not need one). */
  total: number;
}

/** Below this, a set is small enough to read at a glance and the filter is
 *  clutter. Browse mode shows it regardless — a pile scan has always had one. */
export const CAROUSEL_FILTER_MIN = 8;

/** Name-contains, order preserved. Distinct from `filterSortPile`, which also
 *  *sorts*: a prompt's candidate list arrives in the server's order and
 *  reordering it would be lying about the choice (Modal.tsx's rule, kept). A
 *  pile has no such order to respect, so browse mode keeps the scan sort. */
function filterByName(entries: CarouselEntry[], filter: string): CarouselEntry[] {
  const needle = filter.trim().toLowerCase();
  if (needle === '') return entries;
  return entries.filter(e => e.label.toLowerCase().includes(needle));
}

const ZONE_TITLE: Record<BrowseZone, string> = { graveyard: 'graveyard', exile: 'exile' };

/** What the carousel shows right now, or undefined (closed). Prompt mode wins
 *  over an open browse — the ask is the one thing that must be answerable.
 *
 *  `filter` is a name needle applied in every mode: a library search hands you
 *  99 cards and offered no way to find one in them, while the graveyard scan
 *  beside it had a filter all along (Issues.txt #14). `filterKey` fences it to
 *  the content it was typed against — a needle left over from the last ask would
 *  silently hide candidates in the next one — and defaults to unfenced for
 *  callers with a single content in hand. */
export function carouselContent(
  prompt: PromptStoreState | undefined,
  state: GameState | undefined,
  browse: BrowseRef | undefined,
  filter: string,
  filterKey?: string,
): CarouselContent | undefined {
  const needleFor = (key: string): string =>
    filterKey === undefined || filterKey === key ? filter : '';
  const promptContent = (key: string, all: CarouselEntry[]): CarouselContent => ({
    mode: 'prompt', key, title: 'Choose',
    entries: filterByName(all, needleFor(key)), total: all.length,
  });

  const p = prompt?.pending;
  if (p?.kind === 'chooseTargets' && state !== undefined) {
    // The server sent the candidates as cards: they are usually not on the felt
    // at all (a library look) — the fan is the whole affordance.
    if (p.cards !== undefined && p.cards.length > 0) {
      return promptContent(`prompt:${p.promptId}`,
        p.cards.map(c => ({ id: c.id, card: c, label: c.name })));
    }
    // Candidates the board can't offer as a click — pile-zone ids buried under a
    // pile top, ids outside this seat's view. Players are board-reachable (their
    // nameplates ring, §5.2), so they never open the fan.
    const stranded = unreachableCandidates(state, p.candidates)
      .filter(s => !state.players.some(pl => pl.id === s.id));
    if (stranded.length > 0) {
      return promptContent(`prompt:${p.promptId}`,
        stranded.map(s => ({ id: s.id, card: s.card, label: s.label })));
    }
  }
  // Reveal windows (§6 revealed/lookedAt): ambient state, not an ask — they
  // open under any pending prompt (whose candidates, when they point into a
  // window, ring these very cards via affordanceFor) and win over an open
  // browse for exactly as long as the state carries them. They leave via
  // patches, never by dismissal — the classic client's RevealPanels rule.
  if (state !== undefined) {
    const windows = [
      ...(state.revealed ?? []).map(w => ({ ...w, private: false })),
      ...(state.lookedAt ?? []).map(w => ({ ...w, private: true })),
    ].filter(w => w.cards.length > 0);
    if (windows.length > 0) {
      const title = windows
        .map(w => (w.private ? `${w.name} (only you)` : w.name))
        .join(' · ');
      // Names identify the windows; a growing card count keeps the newest
      // additions in view without resetting on unrelated patches.
      const key = `reveal:${windows.map(w => `${w.name}#${w.cards.length}`).join('|')}`;
      const all = windows.flatMap(w => w.cards.map(c => ({ id: c.id, card: c, label: c.name })));
      return {
        mode: 'reveal', key, title,
        entries: filterByName(all, needleFor(key)), total: all.length,
      };
    }
  }
  if (browse !== undefined && state !== undefined) {
    const player = state.players.find(pl => pl.id === browse.playerId);
    if (player !== undefined) {
      const cards = player[browse.zone];
      const key = `browse:${browse.playerId}:${browse.zone}`;
      return {
        mode: 'browse', key,
        title: `${player.name} — ${ZONE_TITLE[browse.zone]} (${cards.length})`,
        // The pile scan sort comes with the filter here (pile.ts) — a pile has no
        // meaningful order of its own to preserve, unlike a candidate list.
        entries: filterSortPile(cards, needleFor(key)).map(c => ({ id: c.id, card: c, label: c.name })),
        total: cards.length,
      };
    }
  }
  return undefined;
}

const CARD_TEX = { w: 200, h: 280 } as const;

// Centre-to-centre spacing, as a fraction of a card. Cards overlap slightly —
// the left ~82% of each shows, which is the name bar, the mana cost and most of
// the art, the same reading the hand fan relies on. Laying them edge to edge
// instead looked tidier and cost a third of the cards on screen: a nine-card
// graveyard used to fit one page and would have needed scrolling. #8 asked for
// the *curve* to go, not for the density.
const STRIP_STEP_RATIO = 0.82;
const STRIP_MARGIN = 32;   // kept clear at both ends of the scrollable run
// The reading window, in cards. A 1440p felt fits ~15 of them edge to edge, and
// filling it made the strip a wall: the eye has nowhere to rest, and a scroll
// moves a row so long that nothing about it changes. Ten is about the span you
// can take in without tracking (asked for 2026-07-30), so past that the strip
// scrolls *inside* a fixed run centred on the felt rather than growing wider.
const STRIP_VISIBLE = 10;
// Width of the dissolve at each end of the run, in cards. Cards do not stop at a
// hard edge — they thin out — so the strip reads as a longer row passing through
// a window, and the presence of a fade is itself the "there is more this way"
// signal (the slider says how much, this says which direction).
const STRIP_FADE_CARDS = 0.8;
// How far past the fade an entry is still given a placement — it must be fully
// invisible before it is culled, plus a little slack so a scroll never pops a
// card into existence somewhere the eye can see it happen.
const STRIP_CULL_CARDS = 0.6;

export interface CarouselStrip {
  /** Clamped scroll offset actually used, px from the strip's start. The scene
   *  writes this back to the store, so an over-scrolled offset self-corrects
   *  on the next sync instead of leaving the slider miles past its end. */
  offset: number;
  /** Largest useful offset. 0 ⇒ the whole strip fits and never scrolls. */
  maxOffset: number;
  /** Centre-to-centre spacing — one "card" of scroll, for the wheel and keys. */
  step: number;
  /** The reading window in screen px: where the run starts and how wide it is.
   *  At most STRIP_VISIBLE cards wide, centred in the felt left of the log. */
  run: { left: number; width: number };
  /** One card's drawn width — the fade ramp and the scene's cull both measure
   *  themselves in these. */
  cardW: number;
  /** Whether the strip continues past each end of the run right now (⇒ that edge
   *  dissolves). Both false when the whole strip fits, so a short reveal window
   *  is drawn plainly and never looks like it is hiding something. */
  fadeLeft: boolean;
  fadeRight: boolean;
  /** Placement per *shown* entry, keyed by its index into `entries`. Entries
   *  scrolled out of the window are absent (see STRIP_CULL_CARDS). */
  placements: Map<number, ActorPlacement>;
}

/** How opaque a strip card at screen-x `x` (its centre) should be: 1 well inside
 *  the run, ramping to 0 across STRIP_FADE_CARDS at whichever end still has more
 *  strip behind it.
 *
 *  Deliberately a function of the card's *live* x rather than a field on its
 *  placement: a card slides into the window over PAGE_TURN_MS, and a placement
 *  alpha would jump to the destination value the instant the tween was armed —
 *  so a card would fade in while still outside the run and arrive already lit.
 *  The scene calls this per frame from the actor's animated position, which is
 *  the only place that reads correctly. Pure, so the ramp is unit-testable. */
export function stripAlphaAt(strip: CarouselStrip, x: number): number {
  const fade = strip.cardW * STRIP_FADE_CARDS;
  if (fade <= 0) return 1;
  const right = strip.run.left + strip.run.width;
  let a = 1;
  if (strip.fadeLeft) a = Math.min(a, (x - strip.run.left) / fade);
  if (strip.fadeRight) a = Math.min(a, (right - x) / fade);
  return a < 0 ? 0 : a > 1 ? 1 : a;
}

/** The strip, in screen coordinates: one flat row of card fronts centred in the
 *  felt left of the log gutter, a band above the hand, scrolled continuously by
 *  `offset` through a window at most STRIP_VISIBLE cards wide whose ends dissolve
 *  while there is more strip past them (Issues.txt #8).
 *
 *  Flat is deliberate. The fan curve — an arc and a per-card rotation — belongs
 *  to the *hand*, where it says "these are yours, held". Wearing it here made a
 *  graveyard scan and a library search read like a second hand you could play
 *  from, and it cost legibility at exactly the moment you are reading names. The
 *  hand keeps its fan; every other zone is a filmstrip.
 *
 *  Continuous, also deliberate. Paging cut a scan into arbitrary blocks of nine
 *  and made "is the card I want in here?" a question you answered one page at a
 *  time; a strip you push is the same gesture as pushing the pile itself. Pure,
 *  so the bar's slider and the canvas can never disagree about where you are. */
export function layoutCarouselStrip(
  count: number, offset: number, viewport: Size, rightInset = 0,
): CarouselStrip {
  const band = handBandHeight(viewport);
  const availW = Math.max(200, viewport.w - Math.max(0, rightInset));
  // A readable face: taller than a hand card, capped so the strip plus the hand
  // still fits the viewport.
  const cardH = Math.min(320, Math.max(200, (viewport.h - band) * 0.42));
  const scale = cardH / CARD_TEX.h;
  const cardW = CARD_TEX.w * scale;
  const step = cardW * STRIP_STEP_RATIO;
  const placements = new Map<number, ActorPlacement>();
  // The reading window: whatever the felt can spare, but never more than
  // STRIP_VISIBLE cards. A long strip scrolls *through* this run.
  const runW = Math.min(availW - 2 * STRIP_MARGIN, step * (STRIP_VISIBLE - 1) + cardW);
  const runLeft = (availW - runW) / 2;
  const run = { left: runLeft, width: runW };
  if (count <= 0) {
    return { offset: 0, maxOffset: 0, step, run, cardW, fadeLeft: false, fadeRight: false, placements };
  }

  const stripW = step * (count - 1) + cardW;
  const maxOffset = Math.max(0, stripW - runW);
  const o = Math.min(Math.max(0, offset), maxOffset);
  // Short enough to fit ⇒ centre it in the felt and never scroll; longer ⇒ pin to
  // the run's left edge and slide, so the first card sits where the eye already is.
  const x0 = maxOffset === 0
    ? (availW - stripW) / 2 + cardW / 2
    : runLeft + cardW / 2 - o;
  const y = viewport.h - band - cardH / 2 - 28;

  // An edge dissolves only while there is strip beyond it. The half-pixel guard
  // keeps a fully-scrolled strip from flickering its trailing edge on rounding.
  const fadeLeft = o > 0.5;
  const fadeRight = o < maxOffset - 0.5;
  const cull = cardW * (STRIP_FADE_CARDS + STRIP_CULL_CARDS);
  for (let i = 0; i < count; i++) {
    const x = x0 + i * step;
    if (x < runLeft - cull || x > runLeft + runW + cull) continue;
    placements.set(i, {
      x, y,
      rotation: 0,            // flat: the fan curve is the hand's alone (#8)
      scale,
      zone: 'library',        // a neutral portrait zone: no battlefield chrome, no hand hit-area
      faceUp: true,
    });
  }
  return { offset: o, maxOffset, step, run, cardW, fadeLeft, fadeRight, placements };
}

/** Where the DOM bar sits: just above the fan's tallest card, as px from the
 *  viewport bottom. Shared so the chrome tracks the canvas geometry. */
export function carouselBarBottom(viewport: Size): number {
  const band = handBandHeight(viewport);
  const cardH = Math.min(320, Math.max(200, (viewport.h - band) * 0.42));
  return band + cardH + 40;
}
