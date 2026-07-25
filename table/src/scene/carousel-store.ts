// Carousel + hand-fan paging UI state (prompts-on-the-table §4.4) — vanilla
// zustand, shared by the scene (which renders the fan) and the DOM chrome
// (CarouselBar / HandPager, which render the buttons). What the carousel
// *shows* is derived (layout/carousel.ts carouselContent), never stored: this
// holds only the player's view-local choices — the open browse ref, the name
// filter, and the page positions.
//
// Pages are keyed by the content's identity (`pageKey`): reading the page for
// a different key yields 0, so a new prompt or a different pile always opens
// on its first page without anyone having to reset anything.

import { createStore } from 'zustand/vanilla';
import type { BrowseRef } from '../layout/carousel';

export interface CarouselUiState {
  browse?: BrowseRef;
  filter: string;
  page: number;
  pageKey: string;
  handPage: number;
}

export const carouselStore = createStore<CarouselUiState>(() => ({
  filter: '', page: 0, pageKey: '', handPage: 0,
}));

/** The stored page for this content identity (0 for any other identity). */
export function pageFor(key: string | undefined): number {
  const s = carouselStore.getState();
  return key !== undefined && s.pageKey === key ? s.page : 0;
}

/** Turn the page for `key` by `delta`, clamped to [0, pageCount). */
export function turnPage(key: string, delta: number, pageCount: number): void {
  const next = Math.min(Math.max(0, pageFor(key) + delta), Math.max(0, pageCount - 1));
  carouselStore.setState({ pageKey: key, page: next });
}

/** Open the browse fan on a pile — clicking the already-open pile closes it.
 *  The filter always starts clean; a leftover needle from the last browse
 *  would silently hide cards. */
export function toggleBrowse(ref: BrowseRef): void {
  const cur = carouselStore.getState().browse;
  const same = cur !== undefined && cur.playerId === ref.playerId && cur.zone === ref.zone;
  carouselStore.setState({ browse: same ? undefined : ref, filter: '' });
}

export function closeBrowse(): void {
  carouselStore.setState({ browse: undefined, filter: '' });
}

export function setFilter(filter: string): void {
  carouselStore.setState({ filter });
}

export function setHandPage(page: number): void {
  carouselStore.setState({ handPage: Math.max(0, page) });
}
