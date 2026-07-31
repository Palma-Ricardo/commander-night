// Carousel + hand-fan paging UI state (prompts-on-the-table §4.4) — vanilla
// zustand, shared by the scene (which renders the fan) and the DOM chrome
// (CarouselBar / HandPager, which render the buttons). What the carousel
// *shows* is derived (layout/carousel.ts carouselContent), never stored: this
// holds only the player's view-local choices — the open browse ref, the name
// filter, and the page positions.
//
// The scroll offset and the name needle are both keyed by the content's identity
// (`viewKey`): reading either for a different key yields its default, so a new
// prompt or a different pile always opens at the start with a clean filter
// without anyone having to reset anything.

import { createStore } from 'zustand/vanilla';
import type { BrowseRef } from '../layout/carousel';

export interface CarouselUiState {
  browse?: BrowseRef;
  /** Name needle, and the content it was typed against. */
  filter: string;
  /** Scroll position along the strip, in px (Issues.txt #8 — continuous, not a
   *  page index). Clamped by the layout, which knows the viewport; the scene
   *  writes the clamped value back so an over-scroll self-corrects. */
  offset: number;
  viewKey: string;
  /** Last `maxOffset` the scene measured, so the DOM slider can size its track.
   *  A measurement cache, not a player choice — the layout is the authority and
   *  re-clamps every sync. */
  maxOffset: number;
  handPage: number;
}

export const carouselStore = createStore<CarouselUiState>(() => ({
  filter: '', offset: 0, viewKey: '', maxOffset: 0, handPage: 0,
}));

/** The stored scroll offset for this content identity (0 for any other). */
export function offsetFor(key: string | undefined): number {
  const s = carouselStore.getState();
  return key !== undefined && s.viewKey === key ? s.offset : 0;
}

/** The stored needle for this content identity ('' for any other). */
export function filterFor(key: string | undefined): string {
  const s = carouselStore.getState();
  return key !== undefined && s.viewKey === key ? s.filter : '';
}

/** Seek the strip for `key` to an absolute offset, clamped to [0, maxOffset]. */
export function setOffset(key: string, offset: number, maxOffset: number): void {
  const next = Math.min(Math.max(0, offset), Math.max(0, maxOffset));
  const s = carouselStore.getState();
  if (s.viewKey === key && s.offset === next && s.maxOffset === maxOffset) return;
  carouselStore.setState({
    viewKey: key, offset: next, maxOffset,
    // Switching content drops the previous needle with it (see the header).
    filter: s.viewKey === key ? s.filter : '',
  });
}

/** Push the strip for `key` along by `delta` px, clamped. */
export function scrollCarousel(key: string, delta: number, maxOffset: number): void {
  setOffset(key, offsetFor(key) + delta, maxOffset);
}

/** Open the browse fan on a pile — clicking the already-open pile closes it.
 *  The filter always starts clean; a leftover needle from the last browse
 *  would silently hide cards. */
export function toggleBrowse(ref: BrowseRef): void {
  const cur = carouselStore.getState().browse;
  const same = cur !== undefined && cur.playerId === ref.playerId && cur.zone === ref.zone;
  carouselStore.setState({ browse: same ? undefined : ref, filter: '', offset: 0 });
}

export function closeBrowse(): void {
  carouselStore.setState({ browse: undefined, filter: '', offset: 0 });
}

/** Type into the needle for `key`. Retyping always seeks back to the strip's
 *  start: the match you are looking for is very unlikely to be under wherever
 *  you happened to have scrolled to. */
export function setFilter(key: string, filter: string): void {
  carouselStore.setState({ viewKey: key, filter, offset: 0 });
}

export function setHandPage(page: number): void {
  carouselStore.setState({ handPage: Math.max(0, page) });
}
