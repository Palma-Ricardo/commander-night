import { describe, expect, it } from 'vitest';
import { decode } from '@night/core/protocol/codec';
import { demoKeyframe } from '../src/fixtures/keyframe';
import { layoutFlat } from '../src/layout/flat';

describe('demo keyframe', () => {
  it('is a valid game.state under the shared strict decoder', () => {
    const r = decode(JSON.stringify(demoKeyframe), { strict: true });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
  });

  it('lays out every enumerated object as a distinct placed actor', () => {
    const placed = layoutFlat(demoKeyframe.state, { w: 1600, h: 900 });
    const keys = new Set(placed.map(p => p.key));
    expect(keys.size).toBe(placed.length);          // no key collisions

    for (const c of demoKeyframe.state.me.hand) expect(keys.has(c.id)).toBe(true);
    for (const pl of demoKeyframe.state.players) {
      for (const perm of pl.battlefield) expect(keys.has(perm.id)).toBe(true);
      for (const c of pl.graveyard) expect(keys.has(c.id)).toBe(true);
      for (const cmd of pl.commandZone) expect(keys.has(cmd.id)).toBe(true);
    }
    expect(placed.some(p => p.placement.zone === 'stack')).toBe(true);
    // opponent hands render as face-down backs
    expect(placed.some(p => p.placement.zone === 'hand' && !p.placement.faceUp)).toBe(true);
  });
});
