import { describe, expect, it } from 'vitest';
import type { Card } from '@night/core';
import {
  accumulateStackLinks, canonicalKey, layoutKeyed, pruneStackLinks, type StackLinks,
} from '../src/scene/keys';
import { demoSession, SPELL, STK, VICTIM } from './session-fixture';

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

  it('does NOT adopt a permanent onto the stack for an ability trigger (T4 ghost)', () => {
    // An ability from VICTIM — still on the battlefield — goes on the stack, its
    // source card carrying the permanent's id, and a stackLink binds them. Adopting
    // it would drag the permanent onto the stack; instead the permanent stays put
    // and the ability keeps its own ephemeral key (the scene flies a ghost).
    const s = structuredClone(demoSession().initial);
    const ABIL = 'stk-ability';
    const srcCard: Card = {
      id: VICTIM, name: 'Grizzly Bears', set: 'X', number: '1', manaValue: 0,
      types: ['CREATURE'], subtypes: [], supertypes: [], colors: [], text: [],
    };
    s.stack.push({ id: ABIL, kind: 'ability', controllerId: 'p1', card: srcCard, text: [] });

    const links: StackLinks = new Map([[ABIL, VICTIM]]);
    const keyed = layoutKeyed(s, VP, links);
    expect(keyed.get(VICTIM)?.placement.zone).toBe('battlefield');   // permanent stays put
    expect(keyed.has(ABIL)).toBe(true);                              // ability keeps its ephemeral key

    // Contrast: a cast (SPELL absent off-stack) still adopts, unifying cast → resolve.
    const cast = demoSession().steps.find(st => st.label === 'cast')!.state;
    expect(layoutKeyed(cast, VP, new Map([[STK, SPELL]])).has(SPELL)).toBe(true);
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
