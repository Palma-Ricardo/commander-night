// The carousel browser (prompts-on-the-table §4.4), headless: what the fan
// shows (content model), where the current page's cards sit (fan layout), and
// the paging store. The scene and the DOM bar both consume these — asserting
// them here pins the one contract they share.

import { describe, expect, it, beforeEach } from 'vitest';
import type { Prompt } from '@night/core';
import type { PromptStoreState } from '@night/core/stores/prompt';
import {
  CAROUSEL_FILTER_MIN, carouselBarBottom, carouselContent, layoutCarouselStrip,
} from '../src/layout/carousel';
import {
  carouselStore, filterFor, offsetFor, scrollCarousel, setFilter, setHandPage, setOffset, toggleBrowse,
} from '../src/scene/carousel-store';
import { handBandHeight, handPageCount } from '../src/layout/screen';
import { fourSeats, mkCard } from './helpers';

const VIEW = { w: 1600, h: 900 };

function promptState(pending: Prompt | undefined, selected: string[] = []): PromptStoreState {
  return { pending, selected, inflight: false, cantPay: [] };
}

const targets = (over: Partial<Extract<Prompt, { kind: 'chooseTargets' }>>): Prompt => ({
  t: 'game.prompt', seq: 1, gameId: 'g1', promptId: 7,
  message: 'Select a card', kind: 'chooseTargets',
  candidates: [], min: 1, max: 1, required: true, ...over,
});

describe('carouselContent', () => {
  it('closed when nothing asks and nothing browses', () => {
    expect(carouselContent(promptState(undefined), fourSeats(), undefined, '')).toBeUndefined();
    expect(carouselContent(undefined, fourSeats(), undefined, '')).toBeUndefined();
  });

  it('a cards[] ask opens prompt mode in server order', () => {
    const cards = [mkCard('Zebra', ['CREATURE']), mkCard('Aardvark', ['CREATURE'])];
    const p = targets({ candidates: cards.map(c => c.id), cards });
    const c = carouselContent(promptState(p), fourSeats(), undefined, '');
    expect(c?.mode).toBe('prompt');
    // server order preserved — never re-sorted (reordering a choice list lies)
    expect(c?.entries.map(e => e.label)).toEqual(['Zebra', 'Aardvark']);
    expect(c?.key).toBe('prompt:7');
  });

  it('unreachable candidates open prompt mode; player candidates never do', () => {
    const state = fourSeats();
    const buried = state.players[1]!.graveyard;
    buried.push(mkCard('Buried Bolt', ['INSTANT']), mkCard('Deeper', ['SORCERY']));
    // both graveyard cards are candidates: the pile top is board-reachable, the
    // buried one is not — the fan must offer the unreachable one
    const p = targets({ candidates: [buried[0]!.id, buried[1]!.id, 'p3'] });
    const c = carouselContent(promptState(p), state, undefined, '');
    expect(c?.mode).toBe('prompt');
    expect(c?.entries.some(e => e.id === 'p3')).toBe(false);
    expect(c!.entries.length).toBeGreaterThan(0);
  });

  it('an all-reachable ask opens nothing', () => {
    const state = fourSeats();
    const onBoard = state.players[0]!.battlefield[0]!.id;
    const c = carouselContent(promptState(targets({ candidates: [onBoard, 'p2'] })), state, undefined, '');
    expect(c).toBeUndefined();
  });

  it('browse mode reads the pile with scan ordering and the name filter', () => {
    const state = fourSeats();
    state.players[0]!.graveyard.push(
      mkCard('Wrath', ['SORCERY'], { manaValue: 4 }),
      mkCard('Llanowar Elves', ['CREATURE'], { manaValue: 1 }),
    );
    const all = carouselContent(promptState(undefined), state, { playerId: 'p1', zone: 'graveyard' }, '');
    expect(all?.mode).toBe('browse');
    expect(all?.title).toContain('You');
    expect(all?.title).toContain('graveyard (3)');
    // scan order: creatures before sorceries (pile.ts), not game order
    expect(all?.entries[0]?.label).toBe('Llanowar Elves');
    const filtered = carouselContent(promptState(undefined), state, { playerId: 'p1', zone: 'graveyard' }, 'wrath');
    expect(filtered?.entries.map(e => e.label)).toEqual(['Wrath']);
  });

  it('a prompt-mode ask wins over an open browse', () => {
    const state = fourSeats();
    const cards = [mkCard('Pick Me', ['CREATURE'])];
    const p = targets({ candidates: [cards[0]!.id], cards });
    const c = carouselContent(promptState(p), state, { playerId: 'p1', zone: 'graveyard' }, '');
    expect(c?.mode).toBe('prompt');
  });

  it('reveal windows open the fan and leave only with the state (§6)', () => {
    const state = fourSeats();
    const shown = [mkCard('Fact', ['INSTANT']), mkCard('Fiction', ['SORCERY'])];
    state.revealed = [{ name: 'Fact or Fiction', cards: shown }];
    const c = carouselContent(promptState(undefined), state, undefined, '');
    expect(c?.mode).toBe('reveal');
    expect(c?.title).toBe('Fact or Fiction');
    expect(c?.entries.map(e => e.label)).toEqual(['Fact', 'Fiction']);  // server order kept
    // gone from state → fan closes; no dismissal path exists
    state.revealed = [];
    expect(carouselContent(promptState(undefined), state, undefined, '')).toBeUndefined();
  });

  it('lookedAt windows are marked private and merge after revealed ones', () => {
    const state = fourSeats();
    state.revealed = [{ name: 'Reveal', cards: [mkCard('Public', ['INSTANT'])] }];
    state.lookedAt = [{ name: 'Scry', cards: [mkCard('Secret', ['SORCERY'])] }];
    const c = carouselContent(promptState(undefined), state, undefined, '');
    expect(c?.mode).toBe('reveal');
    expect(c?.title).toBe('Reveal · Scry (only you)');
    expect(c?.entries.map(e => e.label)).toEqual(['Public', 'Secret']);
  });

  it('reveal wins over browse; a fan-opening ask wins over reveal', () => {
    const state = fourSeats();
    state.revealed = [{ name: 'Reveal', cards: [mkCard('Shown', ['INSTANT'])] }];
    const overBrowse = carouselContent(
      promptState(undefined), state, { playerId: 'p1', zone: 'graveyard' }, '');
    expect(overBrowse?.mode).toBe('reveal');
    const cards = [mkCard('Pick Me', ['CREATURE'])];
    const ask = targets({ candidates: [cards[0]!.id], cards });
    expect(carouselContent(promptState(ask), state, undefined, '')?.mode).toBe('prompt');
  });

  it('an ask whose candidates sit in a reveal window keeps the reveal fan (they ring there)', () => {
    const state = fourSeats();
    const shown = [mkCard('Choose Me', ['INSTANT'])];
    state.revealed = [{ name: 'Revealed', cards: shown }];
    // candidates are board-reachable via the reveal window → prompt mode stays
    // closed and the reveal fan is the surface that rings them
    const ask = targets({ candidates: [shown[0]!.id] });
    const c = carouselContent(promptState(ask), state, undefined, '');
    expect(c?.mode).toBe('reveal');
    expect(c?.entries[0]?.id).toBe(shown[0]!.id);
  });
});

describe('carouselContent name filter (#14)', () => {
  const library = (n: number) => Array.from({ length: n },
    (_, i) => mkCard(i === 3 ? 'Sol Ring' : `Card ${i}`, ['ARTIFACT']));

  it('a library search filters by name, and says how many of how many', () => {
    // The whole of #14: the graveyard scan beside it had a filter all along.
    const cards = library(40);
    const c = carouselContent(promptState(targets({ candidates: cards.map(x => x.id), cards })),
      fourSeats(), undefined, 'sol ring');
    expect(c?.mode).toBe('prompt');
    expect(c?.entries.map(e => e.label)).toEqual(['Sol Ring']);
    expect(c?.total).toBe(40);            // "1 of 40" in the bar
  });

  it('filtering hides but never reorders — the server\'s candidate order is the choice', () => {
    const cards = [mkCard('Zebra', ['CREATURE']), mkCard('Aardvark', ['CREATURE']),
      mkCard('Zealot', ['CREATURE'])];
    const c = carouselContent(promptState(targets({ candidates: cards.map(x => x.id), cards })),
      fourSeats(), undefined, 'z');
    expect(c?.entries.map(e => e.label)).toEqual(['Zebra', 'Zealot']);   // NOT sorted
  });

  it('a reveal window filters too', () => {
    const state = fourSeats();
    state.revealed = [{ name: 'Fact or Fiction', cards: [mkCard('Fact', ['INSTANT']), mkCard('Fiction', ['SORCERY'])] }];
    const c = carouselContent(promptState(undefined), state, undefined, 'fic');
    expect(c?.entries.map(e => e.label)).toEqual(['Fiction']);
    expect(c?.total).toBe(2);
  });

  it('a needle typed against other content is ignored, never applied blind', () => {
    // Fencing: a leftover 'wrath' from the last ask must not silently hide this
    // ask's candidates — which would look exactly like a dead-ended prompt.
    const cards = library(12);
    const p = targets({ candidates: cards.map(x => x.id), cards });
    const stale = carouselContent(promptState(p), fourSeats(), undefined, 'sol ring', 'browse:p1:graveyard');
    expect(stale?.entries.length).toBe(12);
    const mine = carouselContent(promptState(p), fourSeats(), undefined, 'sol ring', stale!.key);
    expect(mine?.entries.length).toBe(1);
  });

  it('an empty needle is a no-op in every mode', () => {
    const cards = library(12);
    const c = carouselContent(promptState(targets({ candidates: cards.map(x => x.id), cards })),
      fourSeats(), undefined, '   ');
    expect(c?.entries.length).toBe(12);
  });

  it('CAROUSEL_FILTER_MIN keeps the input off a set you can read at a glance', () => {
    expect(CAROUSEL_FILTER_MIN).toBeGreaterThan(0);
    const small = library(3);
    const c = carouselContent(promptState(targets({ candidates: small.map(x => x.id), cards: small })),
      fourSeats(), undefined, '');
    expect(c!.total).toBeLessThanOrEqual(CAROUSEL_FILTER_MIN);   // the bar offers no filter here
  });
});

describe('layoutCarouselStrip (#8: one continuous flat strip)', () => {
  it('is flat — no fan curve, no arc: that vocabulary is the hand\'s alone', () => {
    const strip = layoutCarouselStrip(9, 0, VIEW);
    const ys = [...strip.placements.values()].map(p => p.y);
    for (const p of strip.placements.values()) expect(p.rotation).toBe(0);
    expect(Math.max(...ys) - Math.min(...ys)).toBe(0);   // one line, not an arc
  });

  it('a strip that fits is centred and never scrolls', () => {
    const strip = layoutCarouselStrip(3, 0, VIEW);
    expect(strip.maxOffset).toBe(0);
    const xs = [...strip.placements.values()].map(p => p.x);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(VIEW.w / 2, 5);
  });

  it('scrolls continuously — any offset is a position, not a page boundary', () => {
    const n = 40;
    const base = layoutCarouselStrip(n, 0, VIEW);
    expect(base.maxOffset).toBeGreaterThan(0);
    const nudged = layoutCarouselStrip(n, 17, VIEW);       // a third of a card
    const k = [...base.placements.keys()][0]!;
    expect(nudged.placements.get(k)!.x).toBeCloseTo(base.placements.get(k)!.x - 17, 5);
  });

  it('clamps the offset to the run and reports what it used', () => {
    const n = 40;
    expect(layoutCarouselStrip(n, -500, VIEW).offset).toBe(0);
    const end = layoutCarouselStrip(n, 1e6, VIEW);
    expect(end.offset).toBe(end.maxOffset);
    // scrolled to the end, the LAST entry is on screen and the first is gone
    expect(end.placements.has(n - 1)).toBe(true);
    expect(end.placements.has(0)).toBe(false);
  });

  it('culls far-off entries so a 99-card library search is not 99 actors', () => {
    const strip = layoutCarouselStrip(99, 0, VIEW);
    expect(strip.placements.size).toBeLessThan(20);
    expect(strip.placements.has(0)).toBe(true);           // ...but the near ones are all there
    expect([...strip.placements.keys()]).toEqual(
      [...strip.placements.keys()].slice().sort((a, b) => a - b));   // a contiguous window
  });

  it('sits above the hand band at every viewport, starting inside the left margin', () => {
    for (const view of [VIEW, { w: 1280, h: 720 }, { w: 2560, h: 1440 }]) {
      const strip = layoutCarouselStrip(40, 0, view);
      const band = handBandHeight(view);
      for (const p of strip.placements.values()) {
        expect(p.y).toBeLessThan(view.h - band);   // above the hand
        expect(p.y).toBeGreaterThan(0);
      }
      // At offset 0 the first card is fully on screen; the tail runs off the
      // right, which is what there is to scroll to.
      const first = strip.placements.get(0)!;
      const cardW = 200 * first.scale;
      expect(first.x - cardW / 2).toBeGreaterThanOrEqual(0);
      expect(first.x + cardW / 2).toBeLessThan(view.w);
    }
  });

  it('respects the log inset like the hand does — the run ends before the gutter', () => {
    const inset = 360;
    const short = layoutCarouselStrip(3, 0, VIEW, inset);   // fits ⇒ centred in the run
    const xs = [...short.placements.values()].map(p => p.x);
    const cardW = 200 * [...short.placements.values()][0]!.scale;
    expect(Math.max(...xs) + cardW / 2).toBeLessThan(VIEW.w - inset);
    // A long strip's scrollable run is the inset width, not the window width.
    expect(layoutCarouselStrip(40, 0, VIEW, inset).maxOffset)
      .toBeGreaterThan(layoutCarouselStrip(40, 0, VIEW).maxOffset);
  });

  it('keeps each card\'s name bar clear of its neighbour', () => {
    // Cards overlap a little (density — see STRIP_STEP_RATIO), but never so far
    // that the card behind loses the strip you actually read it by.
    const strip = layoutCarouselStrip(9, 0, VIEW);
    const pl = [...strip.placements.values()].sort((a, b) => a.x - b.x);
    const cardW = 200 * pl[0]!.scale;
    for (let i = 1; i < pl.length; i++) {
      expect(pl[i]!.x - pl[i - 1]!.x).toBeGreaterThanOrEqual(cardW * 0.6);
    }
  });

  it('shows appreciably more of a set than the old nine-card page did', () => {
    // The regression guard for the density note on STRIP_STEP_RATIO: an
    // edge-to-edge strip fitted six, and a graveyard scan is worth more than that.
    expect(layoutCarouselStrip(40, 0, VIEW).placements.size).toBeGreaterThanOrEqual(9);
  });

  it('zero entries → an empty strip, never a crash', () => {
    const strip = layoutCarouselStrip(0, 0, VIEW);
    expect(strip.maxOffset).toBe(0);
    expect(strip.placements.size).toBe(0);
  });

  it('the bar sits above the strip cards', () => {
    const strip = layoutCarouselStrip(3, 0, VIEW);
    const top = Math.min(...[...strip.placements.values()].map(p => p.y - (280 * p.scale) / 2));
    expect(VIEW.h - carouselBarBottom(VIEW)).toBeLessThanOrEqual(top + 4);
  });
});

describe('carousel-store scrolling', () => {
  beforeEach(() => carouselStore.setState(
    { browse: undefined, filter: '', offset: 0, viewKey: '', maxOffset: 0, handPage: 0 }));

  it('offset and needle are 0/empty for any other content identity', () => {
    setFilter('prompt:7', 'bolt');
    setOffset('prompt:7', 120, 500);
    expect(offsetFor('prompt:7')).toBe(120);
    expect(filterFor('prompt:7')).toBe('bolt');
    // A different ask must not inherit either — a leftover needle would silently
    // hide the next ask's candidates.
    expect(offsetFor('prompt:8')).toBe(0);
    expect(filterFor('prompt:8')).toBe('');
    expect(offsetFor(undefined)).toBe(0);
  });

  it('scrollCarousel accumulates and clamps to [0, maxOffset]', () => {
    scrollCarousel('k', -50, 300);
    expect(offsetFor('k')).toBe(0);
    scrollCarousel('k', 120, 300);
    scrollCarousel('k', 120, 300);
    expect(offsetFor('k')).toBe(240);
    scrollCarousel('k', 999, 300);
    expect(offsetFor('k')).toBe(300);
  });

  it('re-clamps when the strip shortens under it (a filter, a resize)', () => {
    setOffset('k', 900, 1000);
    setOffset('k', offsetFor('k'), 200);     // the scene re-measures a shorter strip
    expect(offsetFor('k')).toBe(200);
    expect(carouselStore.getState().maxOffset).toBe(200);
  });

  it('switching content drops the previous needle with the offset', () => {
    setFilter('browse:p1:graveyard', 'bolt');
    setOffset('prompt:9', 0, 400);
    expect(filterFor('prompt:9')).toBe('');
    expect(carouselStore.getState().filter).toBe('');
  });

  it('typing a needle seeks back to the start — the match is not where you were', () => {
    setOffset('k', 600, 1000);
    setFilter('k', 'sol');
    expect(offsetFor('k')).toBe(0);
  });

  it('toggleBrowse toggles the same pile and resets the filter', () => {
    toggleBrowse({ playerId: 'p1', zone: 'graveyard' });
    expect(carouselStore.getState().browse).toEqual({ playerId: 'p1', zone: 'graveyard' });
    carouselStore.setState({ filter: 'bolt' });
    toggleBrowse({ playerId: 'p1', zone: 'exile' });
    expect(carouselStore.getState().browse?.zone).toBe('exile');
    expect(carouselStore.getState().filter).toBe('');
    toggleBrowse({ playerId: 'p1', zone: 'exile' });
    expect(carouselStore.getState().browse).toBeUndefined();
  });

  it('setHandPage never goes negative', () => {
    setHandPage(-2);
    expect(carouselStore.getState().handPage).toBe(0);
  });
});

describe('hand paging (§4.4 hand mode)', () => {
  it('a hand at the threshold stays one fan', () => {
    expect(handPageCount(10)).toBe(1);
    expect(handPageCount(0)).toBe(1);
  });

  it('an oversized hand pages', () => {
    expect(handPageCount(11)).toBe(2);
    expect(handPageCount(16)).toBe(2);
    expect(handPageCount(17)).toBe(3);
  });
});
