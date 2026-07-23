// T3 canvas interaction, the Pixi-free half (design §7/§10). The affordance→
// highlight mapping and the click gate are asserted end-to-end against the shared
// @night/core affordance model (affordanceFor), so the canvas highlights exactly
// the cards the classic client would — that shared model is the whole point of
// §7. Plus the quadrant hit-test (felt tap → seat) and the world→screen anchor.

import { describe, expect, it } from 'vitest';
import { affordanceFor } from '@night/core/state/selectors';
import { emptyScratch, type PromptStoreState } from '@night/core/stores/prompt';
import type { Prompt } from '@night/core/protocol/protocol';
import {
  HL_ACTION, HL_COMBAT, HL_SOURCE, HL_TARGET,
  highlightForAffordance, isClickable, rectContains, screenAnchor,
} from '../src/scene/interaction';
import { seatQuadrantRect } from '../src/layout/world';
import { worldToScreen, type CameraPreset } from '../src/camera/camera';

const base = { t: 'game.prompt', seq: 1, gameId: 'g', promptId: 7, message: 'm' } as const;
const withPending = (pending: Prompt): PromptStoreState => ({ ...emptyScratch(), pending });

describe('highlightForAffordance (§7)', () => {
  it('maps every affordance kind to its ring; manaOnly and none stay dark', () => {
    expect(highlightForAffordance(undefined)).toBeUndefined();
    expect(highlightForAffordance({ kind: 'action', actions: [] })).toEqual({ color: HL_ACTION });
    expect(highlightForAffordance({ kind: 'manaOnly', actions: [] })).toBeUndefined();
    expect(highlightForAffordance({ kind: 'target', selected: false })).toEqual({ color: HL_TARGET, selected: false });
    expect(highlightForAffordance({ kind: 'target', selected: true })).toEqual({ color: HL_TARGET, selected: true });
    expect(highlightForAffordance({ kind: 'source', cantPay: false })).toEqual({ color: HL_SOURCE, dim: false });
    expect(highlightForAffordance({ kind: 'source', cantPay: true })).toEqual({ color: HL_SOURCE, dim: true });
    expect(highlightForAffordance({ kind: 'combatCandidate', role: 'attackers' })).toEqual({ color: HL_COMBAT });
    expect(highlightForAffordance({ kind: 'combatDeclared', role: 'blockers' })).toEqual({ color: HL_COMBAT, selected: true });
  });

  it('isClickable is true for every affordance except manaOnly and none', () => {
    expect(isClickable(undefined)).toBe(false);
    expect(isClickable({ kind: 'manaOnly', actions: [] })).toBe(false);
    expect(isClickable({ kind: 'action', actions: [] })).toBe(true);
    expect(isClickable({ kind: 'target', selected: false })).toBe(true);
    expect(isClickable({ kind: 'source', cantPay: false })).toBe(true);
    expect(isClickable({ kind: 'combatCandidate', role: 'attackers' })).toBe(true);
  });
});

describe('canvas highlights track the shared affordance model (§7)', () => {
  it('priority: a castable card lights up and is clickable; a mana-only one does not', () => {
    const prompt = withPending({
      ...base, kind: 'priority', canPass: true,
      playable: {
        castable: [{ kind: 'cast', text: 'Cast Foo' }],
        landonly: [{ kind: 'mana', text: 'Tap for {G}' }],
      },
    });
    const hl = (id: string) => highlightForAffordance(affordanceFor(prompt, id));
    const click = (id: string) => isClickable(affordanceFor(prompt, id));

    expect(hl('castable')).toEqual({ color: HL_ACTION });
    expect(click('castable')).toBe(true);
    // mana-only: never highlighted, never a click target (the float-mana lesson).
    expect(hl('landonly')).toBeUndefined();
    expect(click('landonly')).toBe(false);
    // an object with no affordance is inert.
    expect(hl('bystander')).toBeUndefined();
    expect(click('bystander')).toBe(false);
  });

  it('chooseTargets: only candidates light up, and a chosen one shows selected', () => {
    const prompt: PromptStoreState = {
      ...emptyScratch(),
      selected: ['t1'],
      pending: { ...base, kind: 'chooseTargets', candidates: ['t1', 't2'], min: 1, max: 2, required: true },
    };
    expect(highlightForAffordance(affordanceFor(prompt, 't1'))).toEqual({ color: HL_TARGET, selected: true });
    expect(highlightForAffordance(affordanceFor(prompt, 't2'))).toEqual({ color: HL_TARGET, selected: false });
    expect(highlightForAffordance(affordanceFor(prompt, 'other'))).toBeUndefined();
  });
});

describe('quadrant hit-test (felt tap → seat, §7.3)', () => {
  it("a point in a seat's quadrant is contained by that seat and no other", () => {
    for (let seat = 0; seat < 4; seat++) {
      const q = seatQuadrantRect(seat);
      const centre = { x: q.x + q.w / 2, y: q.y + q.h / 2 };
      expect(rectContains(q, centre)).toBe(true);
      for (let other = 0; other < 4; other++) {
        if (other !== seat) expect(rectContains(seatQuadrantRect(other), centre)).toBe(false);
      }
    }
  });
});

describe('screenAnchor (§10 sceneToScreen)', () => {
  const preset: CameraPreset = { x: 100, y: 50, scale: 0.5, tilt: 0 };

  it('a world actor projects through the live camera; the ring centres on it', () => {
    const pos = { x: 400, y: 300 };
    const scale = 0.62;
    const a = screenAnchor('world', pos, scale, preset);
    const centre = worldToScreen(preset, pos);
    expect(a.left + a.width / 2).toBeCloseTo(centre.x);
    expect(a.top + a.height / 2).toBeCloseTo(centre.y);
    // width = native 200 × placement scale × camera scale
    expect(a.width).toBeCloseTo(200 * scale * preset.scale);
    expect(a.height).toBeCloseTo(280 * scale * preset.scale);
  });

  it('a screen actor (the hand) ignores the camera entirely', () => {
    const pos = { x: 960, y: 900 };
    const scale = 0.6;
    const a = screenAnchor('screen', pos, scale, preset);
    expect(a.left + a.width / 2).toBeCloseTo(pos.x);
    expect(a.top + a.height / 2).toBeCloseTo(pos.y);
    expect(a.width).toBeCloseTo(200 * scale);      // no camera factor
  });
});
