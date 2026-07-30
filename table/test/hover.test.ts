// The hover store is a dumb state holder (T4): the scene owns dismissal timing, so
// the store's only real rule is ownership — a source may hide only the preview *it*
// put up, so the scene's per-frame grace can never yank a DOM-sourced preview (a
// modal card, a log reference) out from under the pointer, and vice versa.

import { beforeEach, describe, expect, it } from 'vitest';
import type { Card } from '@night/core/protocol/protocol';
import {
  hoverStore, hoverCard, hideHover, setPreviewRect, zoomPreview,
  PREVIEW_ZOOM_MIN, PREVIEW_ZOOM_MAX,
} from '../src/chrome/hover';

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

describe('preview wheel zoom (#13)', () => {
  beforeEach(() => hoverStore.setState({}, true));

  it('does not consume the wheel when no preview is open', () => {
    expect(zoomPreview(-100)).toBe(false);
    expect(hoverStore.getState().zoom).toBeUndefined();
  });

  it('scrolling up grows the preview, down shrinks it back', () => {
    hoverCard(card('Bolt'), RECT, 'scene');
    expect(hoverStore.getState().zoom).toBe(PREVIEW_ZOOM_MIN);
    expect(zoomPreview(-100)).toBe(true);                        // wheel up
    const grown = hoverStore.getState().zoom!;
    expect(grown).toBeGreaterThan(PREVIEW_ZOOM_MIN);
    expect(zoomPreview(100)).toBe(true);                         // wheel down
    expect(hoverStore.getState().zoom).toBeCloseTo(PREVIEW_ZOOM_MIN, 6);
  });

  it('clamps at both ends rather than running away', () => {
    hoverCard(card('Bolt'), RECT, 'scene');
    for (let i = 0; i < 200; i++) zoomPreview(-100);
    expect(hoverStore.getState().zoom).toBe(PREVIEW_ZOOM_MAX);
    for (let i = 0; i < 200; i++) zoomPreview(100);
    expect(hoverStore.getState().zoom).toBe(PREVIEW_ZOOM_MIN);
  });

  it('resets per card — the next hover is never left blown up', () => {
    hoverCard(card('Bolt'), RECT, 'scene');
    zoomPreview(-100); zoomPreview(-100);
    expect(hoverStore.getState().zoom).toBeGreaterThan(PREVIEW_ZOOM_MIN);
    hoverCard(card('Bear'), RECT, 'scene');
    expect(hoverStore.getState().zoom).toBe(PREVIEW_ZOOM_MIN);
  });

  it('keeps the card and rect it is zooming', () => {
    hoverCard(card('Bolt'), RECT, 'scene');
    setPreviewRect(RECT);
    zoomPreview(-100);
    const s = hoverStore.getState();
    expect(s.card?.name).toBe('Bolt');
    expect(s.owner).toBe('scene');
    expect(s.previewRect).toEqual(RECT);
  });
});
