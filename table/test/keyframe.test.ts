import { describe, expect, it } from 'vitest';
import { decode } from '@night/core/protocol/codec';
import { demoKeyframe } from '../src/fixtures/keyframe';
import { layoutWorld } from '../src/layout/world';
import { layoutScreen } from '../src/layout/screen';

describe('demo keyframe', () => {
  it('is a valid game.state under the shared strict decoder', () => {
    const r = decode(JSON.stringify(demoKeyframe), { strict: true });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
  });

  it('lays out every enumerated object across the world + screen split', () => {
    const state = demoKeyframe.state;
    const world = layoutWorld(state);
    const screen = layoutScreen(state, { w: 1600, h: 900 });
    const keys = new Set([...world, ...screen].map(p => p.key));
    expect(keys.size).toBe(world.length + screen.length);   // no collisions across spaces

    // my hand is screen-space; everything else is on the felt
    for (const c of state.me.hand) {
      expect(screen.some(p => p.key === c.id && p.space === 'screen')).toBe(true);
    }
    for (const pl of state.players) {
      for (const perm of pl.battlefield) expect(keys.has(perm.id)).toBe(true);
      for (const c of pl.graveyard) expect(keys.has(c.id)).toBe(true);
      for (const cmd of pl.commandZone) expect(keys.has(cmd.id)).toBe(true);
    }
    // the stack is a screen-space right-edge pile (T4), not on the felt
    expect(world.some(p => p.placement.zone === 'stack')).toBe(false);
    expect(screen.some(p => p.placement.zone === 'stack' && p.space === 'screen')).toBe(true);
    // opponent hands render as face-down world backs
    expect(world.some(p => p.placement.zone === 'hand' && !p.placement.faceUp)).toBe(true);
  });
});
