import { describe, expect, it } from 'vitest';
import { handBandHeight, layoutScreen } from '../src/layout/screen';
import { fourSeats, mkPlayer, mkState, SUPPORTED_VIEWPORTS } from './helpers';

describe('handBandHeight', () => {
  it('clamps between 132 and 240 across window sizes', () => {
    for (const vp of [...SUPPORTED_VIEWPORTS, { w: 800, h: 400 }, { w: 3840, h: 2160 }]) {
      const h = handBandHeight(vp);
      expect(h).toBeGreaterThanOrEqual(132);
      expect(h).toBeLessThanOrEqual(240);
    }
  });
});

describe('layoutScreen (the hand)', () => {
  it('places one screen actor per hand card, face up, keyed by id', () => {
    const state = fourSeats();
    for (const vp of SUPPORTED_VIEWPORTS) {
      const placed = layoutScreen(state, vp);
      expect(placed.length).toBe(state.me.hand.length);
      expect(placed.every(p => p.space === 'screen' && p.placement.faceUp && p.placement.zone === 'hand')).toBe(true);
      expect(new Set(placed.map(p => p.key)).size).toBe(placed.length);
    }
  });

  it('keeps every card inside the viewport and within the bottom hand band', () => {
    const state = fourSeats();
    for (const vp of SUPPORTED_VIEWPORTS) {
      const band = handBandHeight(vp);
      for (const p of layoutScreen(state, vp)) {
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

  it('returns nothing for an empty hand', () => {
    const state = mkState([mkPlayer('p1', 'You', { human: true, handSize: 0 })], 'p1');
    expect(layoutScreen(state, { w: 1920, h: 1080 })).toEqual([]);
  });
});
