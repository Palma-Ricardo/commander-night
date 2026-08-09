import { describe, expect, it } from 'vitest';
import type { StackItem } from '@night/core';
import {
  handBandHeight, handFanAlphaAt, layoutHandFan, layoutScreen, stackEffectText, stackGutterWidth,
} from '../src/layout/screen';
import { cid, fourSeats, mkCard, mkPlayer, mkState, SUPPORTED_VIEWPORTS } from './helpers';

const spell = (name: string): StackItem =>
  ({ id: cid('stk'), kind: 'spell', controllerId: 'p1', text: [], card: mkCard(name, ['SORCERY']) });
const abilityItem = (text: string[]): StackItem =>
  ({ id: cid('stk'), kind: 'ability', controllerId: 'p1', text, card: mkCard('Krenko', ['CREATURE']) });
const modalSpell = (chosen: string[]): StackItem =>
  ({ id: cid('stk'), kind: 'spell', controllerId: 'p1', card: mkCard('Cryptic Command', ['INSTANT']),
     text: ['Choose two —', '• A.', '• B.', ...chosen.map(m => `Chosen mode: ${m}`)] });

describe('handBandHeight', () => {
  it('clamps between 150 and 300 across window sizes', () => {
    for (const vp of [...SUPPORTED_VIEWPORTS, { w: 800, h: 400 }, { w: 3840, h: 2160 }]) {
      const h = handBandHeight(vp);
      expect(h).toBeGreaterThanOrEqual(150);
      expect(h).toBeLessThanOrEqual(300);
    }
  });

  it('a tall 1440p window reserves a taller band than a 1080p one (the hand grows with room)', () => {
    expect(handBandHeight({ w: 2560, h: 1440 })).toBeGreaterThan(handBandHeight({ w: 1920, h: 1080 }));
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

  it('a very large hand scrolls: every lit card stays inside the felt', () => {
    // Past what fits, the fan no longer crams — it scrolls, and cards beyond the
    // run dissolve to nothing (they may sit past the edge, but invisibly). So the
    // invariant is on the *lit* cards, not every placement (#8).
    const big = mkPlayer('p1', 'You', { human: true, handSize: 24 });
    const state = mkState([big], 'p1');
    const vp = { w: 1280, h: 720 };
    const fan = layoutHandFan(24, 0, vp);
    expect(fan.maxOffset).toBeGreaterThan(0);           // it overflows ⇒ it scrolls
    const lit = layoutScreen(state, vp)
      .filter(p => p.placement.zone === 'hand' && handFanAlphaAt(fan, p.placement.x) > 0);
    expect(lit.length).toBeGreaterThan(0);
    expect(Math.min(...lit.map(p => p.placement.x))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...lit.map(p => p.placement.x))).toBeLessThanOrEqual(vp.w);
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

describe('layoutScreen (scrollable hand fan, §4.4 / #8)', () => {
  const vp = { w: 1600, h: 900 };
  const oversized = () => mkState([mkPlayer('p1', 'You', { human: true, handSize: 24 })], 'p1');

  it('a hand that fits stays one centred fan and never scrolls, fully lit', () => {
    const state = mkState([mkPlayer('p1', 'You', { human: true, handSize: 10 })], 'p1');
    const fan = layoutHandFan(10, 0, vp);
    expect(fan.maxOffset).toBe(0);
    expect(fan.fadeLeft).toBe(false);
    expect(fan.fadeRight).toBe(false);
    const placed = hand(layoutScreen(state, vp));
    expect(placed.length).toBe(10);
    // a fan that fits hides nothing — every card is opaque end to end
    expect(placed.every(p => handFanAlphaAt(fan, p.placement.x) === 1)).toBe(true);
  });

  it('an oversized hand keeps every card a placed actor, in order, all in the band', () => {
    const state = oversized();
    const band = handBandHeight(vp);
    const placed = hand(layoutScreen(state, vp, 0, false, 0));
    expect(placed.length).toBe(24);                          // nothing is culled…
    expect(placed.map(p => p.key)).toEqual(state.me.hand.map(c => c.id));   // …or reordered
    // it scrolls horizontally — cards never drop below the edge as the old paging
    // tucked them; they all stay in the reserved band.
    expect(placed.every(p => p.placement.y >= vp.h - band && p.placement.y <= vp.h)).toBe(true);
  });

  it('pins to the start at offset 0: only the far end fades', () => {
    const fan = layoutHandFan(24, 0, vp);
    expect(fan.maxOffset).toBeGreaterThan(0);
    expect(fan.fadeLeft).toBe(false);
    expect(fan.fadeRight).toBe(true);
    // the first card sits at the run's left shoulder, fully inside the felt
    const placed = hand(layoutScreen(oversized(), vp, 0, false, 0));
    expect(placed[0]!.placement.x).toBeGreaterThanOrEqual(0);
  });

  it('scrolling slides the fan left and swaps which end fades', () => {
    const state = oversized();
    const fan0 = layoutHandFan(24, 0, vp);
    const at0 = hand(layoutScreen(state, vp, 0, false, 0));
    const atEnd = hand(layoutScreen(state, vp, 0, false, fan0.maxOffset));
    const fanEnd = layoutHandFan(24, fan0.maxOffset, vp);
    expect(fanEnd.fadeLeft).toBe(true);       // scrolled to the end: only the left runs on
    expect(fanEnd.fadeRight).toBe(false);
    // the same card sits further left once scrolled
    expect(atEnd[0]!.placement.x).toBeLessThan(at0[0]!.placement.x);
  });

  it('the offset argument clamps past the end', () => {
    const state = oversized();
    const end = hand(layoutScreen(state, vp, 0, false, layoutHandFan(24, 0, vp).maxOffset));
    const clamped = hand(layoutScreen(state, vp, 0, false, 1e6));
    expect(clamped.map(p => p.placement.x)).toEqual(end.map(p => p.placement.x));
  });

  it('the run re-centres in the felt left of the log gutter', () => {
    const inset = 400;
    const fan = layoutHandFan(24, 0, vp, inset);
    const runMid = fan.run.left + fan.run.width / 2;
    expect(runMid).toBeCloseTo((vp.w - inset) / 2, 1);
  });
});

describe('layoutHandFan + handFanAlphaAt (#8: the scrollable fan window)', () => {
  const vp = { w: 1600, h: 900 };

  it('scrolls past ~12 cards even when the felt has room to spare', () => {
    // The window is capped at HAND_VISIBLE cards, so the fan scrolls at the same
    // hand size on a phone-narrow felt and a 4K one — extra width does not defer it.
    for (const view of [{ w: 1280, h: 720 }, { w: 1600, h: 900 }, { w: 2560, h: 1440 }, { w: 3840, h: 2160 }]) {
      expect(layoutHandFan(12, 0, view).maxOffset, `12 fits @ ${view.w}`).toBe(0);
      expect(layoutHandFan(13, 0, view).maxOffset, `13 scrolls @ ${view.w}`).toBeGreaterThan(0);
    }
  });

  it('clamps the offset to [0, maxOffset]', () => {
    expect(layoutHandFan(24, -500, vp).offset).toBe(0);
    const end = layoutHandFan(24, 1e6, vp);
    expect(end.offset).toBe(end.maxOffset);
  });

  it('a fitting hand is opaque everywhere (no end runs on)', () => {
    const fan = layoutHandFan(6, 0, vp);
    expect(fan.maxOffset).toBe(0);
    for (const x of [fan.run.left, fan.run.left + fan.run.width / 2, fan.run.left + fan.run.width]) {
      expect(handFanAlphaAt(fan, x)).toBe(1);
    }
  });

  it('an overflowing fan dissolves to 0 at a running end and is opaque mid-run', () => {
    const fan = layoutHandFan(24, 200, vp);      // scrolled a little: both ends run on
    expect(fan.fadeLeft).toBe(true);
    expect(fan.fadeRight).toBe(true);
    const right = fan.run.left + fan.run.width;
    expect(handFanAlphaAt(fan, (fan.run.left + right) / 2)).toBe(1);
    expect(handFanAlphaAt(fan, fan.run.left)).toBe(0);
    expect(handFanAlphaAt(fan, right)).toBe(0);
    expect(handFanAlphaAt(fan, fan.run.left - 200)).toBe(0);   // never negative
  });

  it('an empty hand has no fan', () => {
    const fan = layoutHandFan(0, 0, vp);
    expect(fan.maxOffset).toBe(0);
    expect(fan.fadeLeft).toBe(false);
    expect(fan.fadeRight).toBe(false);
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

  it('surfaces an X spell with the chosen X filled into its rules', () => {
    const fireball: StackItem = {
      id: cid('stk'), kind: 'spell', controllerId: 'p1',
      text: ['Fireball deals X damage divided as you choose.'],
      // {X}{R} paid for X=3 ⇒ mana value 4 on the stack (rule 202.3e).
      card: mkCard('Fireball', ['SORCERY'], { manaCost: '{X}{R}', manaValue: 4 }),
    };
    expect(stackEffectText(fireball))
      .toEqual({ label: 'SPELL', lines: ['Fireball deals 3 damage divided as you choose.'] });
  });

  it('fills the chosen X into a modal X spell\'s surfaced mode', () => {
    const item: StackItem = {
      id: cid('stk'), kind: 'spell', controllerId: 'p1',
      card: mkCard('Modal', ['INSTANT'], { manaCost: '{X}{U}', manaValue: 3 }),
      text: ['Choose one —', 'Chosen mode: Scry X.'],
    };
    expect(stackEffectText(item)).toEqual({ label: 'MODE', lines: ['Scry 2.'] });
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

describe('stackGutterWidth (Issues.txt #9 — the pile stops covering the felt)', () => {
  it('is zero with an empty stack: the table gets the whole viewport back', () => {
    for (const vp of SUPPORTED_VIEWPORTS) expect(stackGutterWidth(vp, 0)).toBe(0);
  });

  it('covers the whole pile at every supported viewport', () => {
    for (const vp of SUPPORTED_VIEWPORTS) {
      for (const n of [1, 2, 5, 12]) {
        const xs = stackOf(layoutScreen(withStack(Array.from({ length: n }, (_, i) => spell(`s${i}`))), vp))
          .map(p => ({ x: p.placement.x, halfW: (200 * p.placement.scale) / 2 }));
        // The gutter is measured from the right edge; nothing the pile draws may
        // stick out to the left of it, or a card would sit under that sliver.
        const leftmost = Math.min(...xs.map(c => c.x - c.halfW));
        expect(vp.w - stackGutterWidth(vp, n)).toBeLessThanOrEqual(leftmost);
      }
    }
  });
});
