import { describe, expect, it } from 'vitest';
import {
  accumulateStackLinks, canonicalKey, layoutKeyed, pruneStackLinks, type StackLinks,
} from '../src/scene/keys';
import { demoSession, SPELL, STK } from './session-fixture';

const VP = { w: 1600, h: 900 };

describe('stackLink canonicalization (§3, §6.1)', () => {
  it('folds stackLink events into the link map, ignoring other kinds', () => {
    const links: StackLinks = new Map();
    accumulateStackLinks(links, [
      { k: 'move', objectId: SPELL, from: 'hand', to: 'stack', verb: 'cast' },
      { k: 'stackLink', stackId: STK, objectId: SPELL },
      { k: 'step', activePlayerId: 'p2' },
    ]);
    expect(links.get(STK)).toBe(SPELL);
    expect(links.size).toBe(1);
  });

  it('remaps a stack id to its object, leaves other keys alone', () => {
    const links: StackLinks = new Map([[STK, SPELL]]);
    expect(canonicalKey(STK, links)).toBe(SPELL);
    expect(canonicalKey('some-battlefield-id', links)).toBe('some-battlefield-id');
  });

  it('adopts the stack actor onto the stable id, unifying cast → resolve', () => {
    const cast = demoSession().steps.find(s => s.label === 'cast')!.state;

    // Without the link the stack actor is keyed by the ephemeral stack id — the
    // teleport-out-of-hand fallback the classic client shows.
    const raw = layoutKeyed(cast, VP, new Map());
    expect(raw.has(STK)).toBe(true);
    expect(raw.has(SPELL)).toBe(false);

    // With it, the stack actor is the same actor the hand card was → it animates.
    const links: StackLinks = new Map([[STK, SPELL]]);
    const keyed = layoutKeyed(cast, VP, links);
    expect(keyed.has(SPELL)).toBe(true);
    expect(keyed.has(STK)).toBe(false);
    expect(keyed.get(SPELL)!.placement.zone).toBe('stack');
  });

  it('prunes a link once its spell has left the stack', () => {
    const { steps } = demoSession();
    const cast = steps.find(s => s.label === 'cast')!.state;
    const resolved = steps.find(s => s.label === 'resolve')!.state;
    const links: StackLinks = new Map([[STK, SPELL]]);

    pruneStackLinks(links, cast);         // spell still on the stack — kept
    expect(links.has(STK)).toBe(true);
    pruneStackLinks(links, resolved);     // spell resolved off — dropped
    expect(links.has(STK)).toBe(false);
  });
});
