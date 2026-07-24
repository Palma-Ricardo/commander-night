import { describe, expect, it } from 'vitest';
import type { StackItem } from '@night/core';
import { handBandHeight, layoutScreen, stackEffectText } from '../src/layout/screen';
import { cid, fourSeats, mkCard, mkPlayer, mkState, SUPPORTED_VIEWPORTS } from './helpers';

const spell = (name: string): StackItem =>
  ({ id: cid('stk'), kind: 'spell', controllerId: 'p1', text: [], card: mkCard(name, ['SORCERY']) });
const abilityItem = (text: string[]): StackItem =>
  ({ id: cid('stk'), kind: 'ability', controllerId: 'p1', text, card: mkCard('Krenko', ['CREATURE']) });
const modalSpell = (chosen: string[]): StackItem =>
  ({ id: cid('stk'), kind: 'spell', controllerId: 'p1', card: mkCard('Cryptic Command', ['INSTANT']),
     text: ['Choose two —', '• A.', '• B.', ...chosen.map(m => `Chosen mode: ${m}`)] });

describe('handBandHeight', () => {
  it('clamps between 132 and 240 across window sizes', () => {
    for (const vp of [...SUPPORTED_VIEWPORTS, { w: 800, h: 400 }, { w: 3840, h: 2160 }]) {
      const h = handBandHeight(vp);
      expect(h).toBeGreaterThanOrEqual(132);
      expect(h).toBeLessThanOrEqual(240);
    }
  });
});

const hand = (placed: ReturnType<typeof layoutScreen>) => placed.filter(p => p.placement.zone === 'hand');

describe('layoutScreen (the hand)', () => {
  it('places one screen actor per hand card, face up, keyed by id', () => {
    const state = fourSeats();
    for (const vp of SUPPORTED_VIEWPORTS) {
      const placed = hand(layoutScreen(state, vp));
      expect(placed.length).toBe(state.me.hand.length);
      expect(placed.every(p => p.space === 'screen' && p.placement.faceUp && p.placement.zone === 'hand')).toBe(true);
      expect(new Set(placed.map(p => p.key)).size).toBe(placed.length);
    }
  });

  it('keeps every card inside the viewport and within the bottom hand band', () => {
    const state = fourSeats();
    for (const vp of SUPPORTED_VIEWPORTS) {
      const band = handBandHeight(vp);
      for (const p of hand(layoutScreen(state, vp))) {
        expect(p.placement.x).toBeGreaterThanOrEqual(0);
        expect(p.placement.x).toBeLessThanOrEqual(vp.w);
        // card centre sits inside the reserved bottom band
        expect(p.placement.y).toBeGreaterThanOrEqual(vp.h - band);
        expect(p.placement.y).toBeLessThanOrEqual(vp.h);
      }
    }
  });

  it('centres the fan around the viewport midline', () => {
    const state = fourSeats();
    for (const vp of SUPPORTED_VIEWPORTS) {
      const xs = layoutScreen(state, vp).map(p => p.placement.x);
      const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
      expect(mid).toBeCloseTo(vp.w / 2, 1);
    }
  });

  it('does not overflow the window width with a very large hand', () => {
    const big = mkPlayer('p1', 'You', { human: true, handSize: 18 });
    const state = mkState([big], 'p1');
    const vp = { w: 1280, h: 720 };
    const xs = layoutScreen(state, vp).map(p => p.placement.x);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(vp.w);
  });

  it('re-centres the fan in the felt left of the log gutter', () => {
    const state = fourSeats();
    const vp = { w: 1920, h: 1080 };
    const inset = 400;
    const mid = (xs: number[]) => (Math.min(...xs) + Math.max(...xs)) / 2;

    const open = layoutScreen(state, vp, inset).map(p => p.placement.x);
    const closed = layoutScreen(state, vp, 0).map(p => p.placement.x);
    // the fan centres on the visible midline (viewport minus the gutter)…
    expect(mid(open)).toBeCloseTo((vp.w - inset) / 2, 1);
    // …i.e. shifted left of the full-viewport centre by half the gutter, and still
    // clear of both edges of the felt that's left.
    expect(mid(closed) - mid(open)).toBeCloseTo(inset / 2, 1);
    for (const x of open) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(vp.w - inset);
    }
  });

  it('returns nothing for an empty hand', () => {
    const state = mkState([mkPlayer('p1', 'You', { human: true, handSize: 0 })], 'p1');
    expect(hand(layoutScreen(state, { w: 1920, h: 1080 }))).toEqual([]);
  });
});

const stackOf = (placed: ReturnType<typeof layoutScreen>) => placed.filter(p => p.placement.zone === 'stack');
const withStack = (items: StackItem[], handSize = 4) =>
  mkState([mkPlayer('p1', 'You', { human: true, handSize })], 'p1', { stack: items });

describe('layoutScreen (the stack pile)', () => {
  it('places one screen actor per stack item, face up, keyed by the stack id', () => {
    const items = [spell('Cultivate'), spell('Counterspell'), spell('Bolt')];
    for (const vp of SUPPORTED_VIEWPORTS) {
      const s = stackOf(layoutScreen(withStack(items), vp));
      expect(s.length).toBe(items.length);
      expect(s.every(p => p.space === 'screen' && p.placement.faceUp && p.placement.zone === 'stack')).toBe(true);
      expect(s.map(p => p.key)).toEqual(items.map(i => i.id));   // keyed by ephemeral stack id
    }
  });

  it('is absent when the stack is empty', () => {
    expect(stackOf(layoutScreen(withStack([]), { w: 1920, h: 1080 }))).toEqual([]);
  });

  it('pins the pile to the right edge, top-of-stack frontmost', () => {
    const items = [spell('bottom'), spell('middle'), spell('top')];
    const vp = { w: 1920, h: 1080 };
    const s = stackOf(layoutScreen(withStack(items), vp));
    const top = s[s.length - 1]!;      // last item = top of stack = next to resolve
    // the top card is the rightmost, largest, and untilted — the fully-visible face
    expect(top.placement.x).toBe(Math.max(...s.map(p => p.placement.x)));
    expect(top.placement.scale).toBe(Math.max(...s.map(p => p.placement.scale)));
    expect(top.placement.rotation).toBeCloseTo(0, 10);
    // the whole pile hugs the right edge, well past the midline
    expect(top.placement.x).toBeGreaterThan(vp.w * 0.7);
  });

  it('fans older items to the left of the top card', () => {
    const items = [spell('a'), spell('b'), spell('c'), spell('d')];
    const vp = { w: 1920, h: 1080 };
    const xs = stackOf(layoutScreen(withStack(items), vp)).map(p => p.placement.x);
    // bottom → top is left → right (each newer item sits in front, to the right)
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
  });

  it('does not overrun the felt centre even with a deep stack', () => {
    const items = Array.from({ length: 16 }, (_, i) => spell(`t${i}`));
    const vp = { w: 1920, h: 1080 };
    const xs = stackOf(layoutScreen(withStack(items), vp)).map(p => p.placement.x);
    expect(Math.min(...xs)).toBeGreaterThan(vp.w * 0.4);   // never crosses into the left half
  });

  it('shifts the pile left of the log gutter when it opens', () => {
    const items = [spell('x')];
    const vp = { w: 1920, h: 1080 };
    const closed = stackOf(layoutScreen(withStack(items), vp, 0))[0]!.placement.x;
    const open = stackOf(layoutScreen(withStack(items), vp, 400))[0]!.placement.x;
    expect(open).toBeLessThan(closed);              // the gutter pushes it inward
    expect(open).toBeLessThanOrEqual(vp.w - 400);   // clear of the panel
  });
});

describe('stackEffectText (what to overlay on a stack card)', () => {
  it('surfaces a triggered ability\'s own rules under an ABILITY header', () => {
    const e = stackEffectText(abilityItem(['Create a 1/1 red Goblin creature token.']));
    expect(e).toEqual({ label: 'ABILITY', lines: ['Create a 1/1 red Goblin creature token.'] });
  });

  it('drops blank lines but keeps the ABILITY header even when the rules scrape to nothing', () => {
    expect(stackEffectText(abilityItem(['', '  ']))).toEqual({ label: 'ABILITY', lines: [] });
  });

  it('leaves a plain spell untouched (its printed box is what resolves)', () => {
    expect(stackEffectText(spell('Reality Shift'))).toBeUndefined();
  });

  it('surfaces the one chosen mode of a modal spell under a MODE header', () => {
    expect(stackEffectText(modalSpell(['Counter target spell.'])))
      .toEqual({ label: 'MODE', lines: ['Counter target spell.'] });
  });

  it('surfaces every chosen mode under a plural MODES header, prefix stripped', () => {
    expect(stackEffectText(modalSpell(['Counter target spell.', 'Draw a card.'])))
      .toEqual({ label: 'MODES', lines: ['Counter target spell.', 'Draw a card.'] });
  });
});

describe('layoutScreen (the stack spread for stack-item targeting)', () => {
  it('un-fans into a centred, uniform, non-overlapping row', () => {
    const items = [spell('a'), spell('b'), spell('c'), spell('d')];
    const vp = { w: 1920, h: 1080 };
    const s = stackOf(layoutScreen(withStack(items), vp, 0, true));
    expect(s.length).toBe(items.length);
    // every card the same size and upright — a clean row, not a fan
    expect(new Set(s.map(p => p.placement.scale)).size).toBe(1);
    expect(s.every(p => p.placement.rotation === 0)).toBe(true);
    // left→right in stack order, centred on the viewport midline
    const xs = s.map(p => p.placement.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(vp.w / 2, 1);
    // adjacent centres are more than a card apart ⇒ each item is separated
    const cardW = 200 * s[0]!.placement.scale;
    expect(xs[1]! - xs[0]!).toBeGreaterThan(cardW);
  });

  it('keeps a deep spread within the viewport', () => {
    const items = Array.from({ length: 12 }, (_, i) => spell(`t${i}`));
    const vp = { w: 1366, h: 768 };
    const xs = stackOf(layoutScreen(withStack(items), vp, 0, true)).map(p => p.placement.x);
    expect(Math.min(...xs)).toBeGreaterThan(0);
    expect(Math.max(...xs)).toBeLessThan(vp.w);
  });

  it('centres the spread left of the log gutter', () => {
    const items = [spell('a'), spell('b'), spell('c')];
    const vp = { w: 1920, h: 1080 };
    const xs = stackOf(layoutScreen(withStack(items), vp, 500, true)).map(p => p.placement.x);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo((vp.w - 500) / 2, 1);
    expect(Math.max(...xs)).toBeLessThan(vp.w - 500);
  });
});
