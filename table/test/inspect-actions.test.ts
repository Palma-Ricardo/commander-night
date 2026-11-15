import { describe, expect, it } from 'vitest';
import { inspectButtons } from '../src/chrome/inspect-actions';

describe('inspectButtons (mobile plan §3)', () => {
  it('a castable spell offers Cast', () => {
    const b = inspectButtons({ kind: 'action', actions: [{ kind: 'cast', text: 'Cast Counterspell' }] }, false);
    expect(b).toEqual([{ label: 'Cast', verb: 'click', primary: true }]);
  });

  it('a land offers Play', () => {
    expect(inspectButtons({ kind: 'action', actions: [{ kind: 'play', text: 'Play Forest' }] }, false)[0]!.label).toBe('Play');
  });

  it('mixed non-mana kinds fall back to a neutral verb', () => {
    const b = inspectButtons({ kind: 'action', actions: [
      { kind: 'cast', text: 'Cast' }, { kind: 'ability', text: 'Cycling {2}' }] }, false);
    expect(b[0]!.label).toBe('Use…');
  });

  it('mana-only cards get the mana button the canvas never had', () => {
    expect(inspectButtons({ kind: 'manaOnly', actions: [{ kind: 'mana', text: '{T}: Add {G}.' }] }, false))
      .toEqual([{ label: 'Tap for mana', verb: 'mana', primary: true }]);
  });

  it('targets toggle, sources pay, combat declares', () => {
    expect(inspectButtons({ kind: 'target', selected: false }, false)[0]!.label).toBe('Choose as target');
    expect(inspectButtons({ kind: 'target', selected: true }, false)[0]!.label).toBe('Unselect target');
    expect(inspectButtons({ kind: 'source', cantPay: true }, false)[0]!.primary).toBe(false);
    expect(inspectButtons({ kind: 'combatCandidate', role: 'attackers' }, false)[0]!.label).toBe('Attack');
    expect(inspectButtons({ kind: 'combatCandidate', role: 'blockers' }, false)[0]!.label).toBe('Block');
    expect(inspectButtons({ kind: 'combatDeclared', role: 'attackers' }, false)[0]!.label).toBe('Remove attacker');
  });

  it('offers nothing to act on with no affordance or an answer in flight', () => {
    expect(inspectButtons(undefined, false)).toEqual([]);
    expect(inspectButtons({ kind: 'combatCandidate', role: 'attackers' }, true)).toEqual([]);
  });
});
