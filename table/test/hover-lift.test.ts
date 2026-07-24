// The hand hover-lift geometry (§9), restoring the classic `.hand-slot:hover`.
// The one property that matters for feel is the no-flicker invariant: the lifted
// card's *bottom* edge must never rise above its resting bottom, or it slides up
// out from under the pointer that triggered the hover — dropping :hover, lowering
// the card, re-entering, and oscillating. Asserted here without Pixi.

import { describe, expect, it } from 'vitest';
import { handHoverLift } from '../src/render/CardActor';

const TEX_H = 300;   // a card texture's native height (portrait tier)
const SCALE = 0.8;

/** The card's bottom edge (own-space y, card centred at 0) at hover amount `amt`. */
function bottomEdge(amt: number): number {
  const { scale, lift } = handHoverLift(TEX_H, SCALE, amt);
  return -lift + (TEX_H * scale) / 2;   // centre shifts up by `lift`, half-height grows
}

describe('handHoverLift', () => {
  it('at rest it is a no-op — no grow, no lift', () => {
    expect(handHoverLift(TEX_H, SCALE, 0)).toEqual({ scale: SCALE, lift: 0 });
  });

  it('grows the card toward 1.6× and raises it', () => {
    const full = handHoverLift(TEX_H, SCALE, 1);
    expect(full.scale).toBeCloseTo(SCALE * 1.6, 6);
    expect(full.lift).toBeGreaterThan(0);
  });

  it('NO FLICKER: the bottom edge never rises above rest, at any hover amount', () => {
    const rest = bottomEdge(0);
    for (let amt = 0; amt <= 1.0001; amt += 0.05) {
      expect(bottomEdge(amt)).toBeGreaterThanOrEqual(rest - 1e-9);
    }
  });

  it('the lift is monotonic in the hover amount (a smooth rise, never a dip)', () => {
    let prev = -Infinity;
    for (let amt = 0; amt <= 1.0001; amt += 0.1) {
      const { lift } = handHoverLift(TEX_H, SCALE, amt);
      expect(lift).toBeGreaterThanOrEqual(prev);
      prev = lift;
    }
  });
});
