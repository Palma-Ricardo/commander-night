// The carousel browser (prompts-on-the-table §4.4), headless: what the fan
// shows (content model), where the current page's cards sit (fan layout), and
// the paging store. The scene and the DOM bar both consume these — asserting
// them here pins the one contract they share.

import { describe, expect, it, beforeEach } from 'vitest';
import type { Prompt } from '@night/core';
import type { PromptStoreState } from '@night/core/stores/prompt';
import {
  carouselBarBottom, carouselContent, carouselPageCount, layoutCarouselFan,
} from '../src/layout/carousel';
import { carouselStore, pageFor, setHandPage, toggleBrowse, turnPage } from '../src/scene/carousel-store';
import { handBandHeight, handPageCount } from '../src/layout/screen';
import { CAROUSEL_PAGE_SIZE } from '../src/tuning';
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
});

describe('layoutCarouselFan', () => {
  it('pages at CAROUSEL_PAGE_SIZE and clamps the requested page', () => {
    const n = CAROUSEL_PAGE_SIZE * 2 + 3;
    expect(carouselPageCount(n)).toBe(3);
    const fan = layoutCarouselFan(n, 99, VIEW);
    expect(fan.page).toBe(2);
    expect(fan.pageCount).toBe(3);
    expect([...fan.placements.keys()]).toEqual([CAROUSEL_PAGE_SIZE * 2, CAROUSEL_PAGE_SIZE * 2 + 1, CAROUSEL_PAGE_SIZE * 2 + 2]);
  });

  it('lays the page inside the viewport, above the hand band', () => {
    for (const view of [VIEW, { w: 1280, h: 720 }, { w: 2560, h: 1440 }]) {
      const fan = layoutCarouselFan(CAROUSEL_PAGE_SIZE, 0, view);
      const band = handBandHeight(view);
      for (const p of fan.placements.values()) {
        expect(p.x).toBeGreaterThan(0);
        expect(p.x).toBeLessThan(view.w);
        expect(p.y).toBeLessThan(view.h - band);   // above the hand
        expect(p.y).toBeGreaterThan(0);
      }
    }
  });

  it('respects the log inset like the hand does', () => {
    const inset = 360;
    const fan = layoutCarouselFan(CAROUSEL_PAGE_SIZE, 0, VIEW, inset);
    for (const p of fan.placements.values()) {
      expect(p.x).toBeLessThan(VIEW.w - inset);
    }
  });

  it('zero entries → an empty page, never a crash', () => {
    const fan = layoutCarouselFan(0, 0, VIEW);
    expect(fan.pageCount).toBe(1);
    expect(fan.placements.size).toBe(0);
  });

  it('the bar sits above the fan cards', () => {
    const fan = layoutCarouselFan(3, 0, VIEW);
    const topOfFan = Math.min(...[...fan.placements.values()].map(p => p.y - (280 * p.scale) / 2));
    expect(VIEW.h - carouselBarBottom(VIEW)).toBeLessThanOrEqual(topOfFan + 4);
  });
});

describe('carousel-store paging', () => {
  beforeEach(() => carouselStore.setState({ browse: undefined, filter: '', page: 0, pageKey: '', handPage: 0 }));

  it('pageFor is 0 for any other content identity', () => {
    turnPage('prompt:7', 1, 3);
    expect(pageFor('prompt:7')).toBe(1);
    expect(pageFor('prompt:8')).toBe(0);
    expect(pageFor(undefined)).toBe(0);
  });

  it('turnPage clamps to [0, pageCount)', () => {
    turnPage('k', -1, 3);
    expect(pageFor('k')).toBe(0);
    turnPage('k', 5, 3);
    expect(pageFor('k')).toBe(2);
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
