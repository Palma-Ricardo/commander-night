// The hover store is a dumb state holder (T4): the scene owns dismissal timing, so
// the store's only real rule is ownership — a source may hide only the preview *it*
// put up, so the scene's per-frame grace can never yank a DOM-sourced preview (a
// modal card, a log reference) out from under the pointer, and vice versa.

import { beforeEach, describe, expect, it } from 'vitest';
import type { Card } from '@night/core/protocol/protocol';
import { hoverStore, hoverCard, hideHover, setPreviewRect } from '../src/chrome/hover';

const card = (name: string): Card => ({
  id: name, name, set: 's', number: '1', colors: [], types: ['CREATURE'],
  supertypes: [], subtypes: [], text: [],
} as unknown as Card);

const RECT = { left: 10, top: 20, width: 100, height: 140 };

describe('hover store ownership', () => {
  beforeEach(() => hoverStore.setState({}, true));

  it('records the owner that put a card up (defaults to dom)', () => {
    hoverCard(card('Bear'), RECT);
    expect(hoverStore.getState().owner).toBe('dom');
    hoverCard(card('Bear'), RECT, 'scene');
    expect(hoverStore.getState().owner).toBe('scene');
  });

  it('hideHover only clears its own preview', () => {
    hoverCard(card('Bear'), RECT, 'scene');
    hideHover('dom');                                    // a stale DOM grace…
    expect(hoverStore.getState().card).not.toBeUndefined();   // …must not clear the scene's
    hideHover('scene');
    expect(hoverStore.getState().card).toBeUndefined();
  });

  it('the reverse holds — the scene cannot dismiss a DOM preview', () => {
    hoverCard(card('Bolt'), RECT, 'dom');
    hideHover('scene');
    expect(hoverStore.getState().card).not.toBeUndefined();
    hideHover('dom');
    expect(hoverStore.getState().card).toBeUndefined();
  });

  it('a fresh hover clears any stale published preview rect', () => {
    hoverCard(card('Bear'), RECT, 'scene');
    setPreviewRect({ left: 1, top: 2, width: 3, height: 4 });
    expect(hoverStore.getState().previewRect).toEqual({ left: 1, top: 2, width: 3, height: 4 });
    hoverCard(card('Bolt'), RECT, 'scene');
    expect(hoverStore.getState().previewRect).toBeUndefined();
  });

  it('setPreviewRect updates the rect without disturbing the shown card', () => {
    hoverCard(card('Bear'), RECT, 'scene');
    setPreviewRect(RECT);
    const s = hoverStore.getState();
    expect(s.card?.name).toBe('Bear');
    expect(s.previewRect).toEqual(RECT);
  });
});
