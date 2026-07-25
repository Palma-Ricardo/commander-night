// The carousel browser (prompts-on-the-table §4.4), pure and headless: what the
// fan shows (`carouselContent`) and where each card of the current page sits
// (`layoutCarouselFan`). The scene renders the result as screen-space CardActors
// — the same fan vocabulary as the hand, one band above it — and the DOM bar
// (chrome/CarouselBar) renders the title/filter/paging chrome from the same
// content, so canvas and chrome can never disagree about what is open.
//
// Two clients of one surface:
//  • Prompt mode — a chooseTargets whose candidates the felt can't offer: a
//    `cards[]` grid (library looks, an opponent's graveyard pick) or candidate
//    ids outside this seat's view (§5.2 / §13 no-dead-end). Auto-opens; server
//    candidate order is preserved (reordering a choice list would be lying —
//    Modal.tsx's rule, kept). Closes only with its prompt.
//  • Browse mode — a clicked graveyard/exile pile, read-only, with the scan
//    ordering + name filter from pile.ts. A pending prompt-mode ask *wins* over
//    an open browse; the browse reappears when the ask clears.

import type { Card, GameState, Id } from '@night/core';
import { unreachableCandidates } from '@night/core/state/selectors';
import type { PromptStoreState } from '@night/core/stores/prompt';
import { CAROUSEL_PAGE_SIZE } from '../tuning';
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
  mode: 'prompt' | 'browse';
  /** Identity for page-reset: a new key starts back at page 0. */
  key: string;
  title: string;
  entries: CarouselEntry[];
}

const ZONE_TITLE: Record<BrowseZone, string> = { graveyard: 'graveyard', exile: 'exile' };

/** What the carousel shows right now, or undefined (closed). Prompt mode wins
 *  over an open browse — the ask is the one thing that must be answerable. */
export function carouselContent(
  prompt: PromptStoreState | undefined,
  state: GameState | undefined,
  browse: BrowseRef | undefined,
  filter: string,
): CarouselContent | undefined {
  const p = prompt?.pending;
  if (p?.kind === 'chooseTargets' && state !== undefined) {
    // The server sent the candidates as cards: they are usually not on the felt
    // at all (a library look) — the fan is the whole affordance.
    if (p.cards !== undefined && p.cards.length > 0) {
      return {
        mode: 'prompt', key: `prompt:${p.promptId}`, title: 'Choose',
        entries: p.cards.map(c => ({ id: c.id, card: c, label: c.name })),
      };
    }
    // Candidates the board can't offer as a click — pile-zone ids buried under a
    // pile top, ids outside this seat's view. Players are board-reachable (their
    // nameplates ring, §5.2), so they never open the fan.
    const stranded = unreachableCandidates(state, p.candidates)
      .filter(s => !state.players.some(pl => pl.id === s.id));
    if (stranded.length > 0) {
      return {
        mode: 'prompt', key: `prompt:${p.promptId}`, title: 'Choose',
        entries: stranded.map(s => ({ id: s.id, card: s.card, label: s.label })),
      };
    }
  }
  if (browse !== undefined && state !== undefined) {
    const player = state.players.find(pl => pl.id === browse.playerId);
    if (player !== undefined) {
      const cards = player[browse.zone];
      return {
        mode: 'browse',
        key: `browse:${browse.playerId}:${browse.zone}`,
        title: `${player.name} — ${ZONE_TITLE[browse.zone]} (${cards.length})`,
        entries: filterSortPile(cards, filter).map(c => ({ id: c.id, card: c, label: c.name })),
      };
    }
  }
  return undefined;
}

export function carouselPageCount(count: number): number {
  return Math.max(1, Math.ceil(count / CAROUSEL_PAGE_SIZE));
}

const CARD_TEX = { w: 200, h: 280 } as const;

export interface CarouselFan {
  /** Clamped page actually shown. */
  page: number;
  pageCount: number;
  /** Placement per shown entry, keyed by its index into `entries`. */
  placements: Map<number, ActorPlacement>;
}

/** The current page's fan, in screen coordinates: centred in the felt left of
 *  the log gutter, one band above the hand, arced like the hand fan but with
 *  enough spread that every face reads. Pure — the bar and the scene both call
 *  it, so the page the buttons show is the page the cards show. */
export function layoutCarouselFan(
  count: number, page: number, viewport: Size, rightInset = 0,
): CarouselFan {
  const pageCount = carouselPageCount(count);
  const p = Math.min(Math.max(0, page), pageCount - 1);
  const start = p * CAROUSEL_PAGE_SIZE;
  const n = Math.min(CAROUSEL_PAGE_SIZE, count - start);
  const placements = new Map<number, ActorPlacement>();
  if (n <= 0) return { page: p, pageCount, placements };

  const band = handBandHeight(viewport);
  const availW = Math.max(200, viewport.w - Math.max(0, rightInset));
  // A readable face: taller than a hand card, capped so a full page plus the
  // hand still fits the viewport.
  const cardH = Math.min(320, Math.max(200, (viewport.h - band) * 0.42));
  const scale = cardH / CARD_TEX.h;
  const cardW = CARD_TEX.w * scale;
  const margin = 32;
  const step = n > 1 ? Math.min(cardW * 0.78, (availW - cardW - 2 * margin) / (n - 1)) : 0;
  const spanW = step * (n - 1);
  const cx = availW / 2;
  const baseY = viewport.h - band - cardH / 2 - 28;

  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) - 0.5 : 0;        // -0.5 … 0.5 across the fan
    placements.set(start + i, {
      x: cx - spanW / 2 + i * step,
      y: baseY + Math.abs(t) * cardH * 0.06,        // slight downward arc at the ends
      rotation: t * 0.06,
      scale,
      zone: 'library',        // a neutral portrait zone: no battlefield chrome, no hand hit-area
      faceUp: true,
    });
  }
  return { page: p, pageCount, placements };
}

/** Where the DOM bar sits: just above the fan's tallest card, as px from the
 *  viewport bottom. Shared so the chrome tracks the canvas geometry. */
export function carouselBarBottom(viewport: Size): number {
  const band = handBandHeight(viewport);
  const cardH = Math.min(320, Math.max(200, (viewport.h - band) * 0.42));
  return band + cardH + 40;
}
