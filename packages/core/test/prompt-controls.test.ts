// promptControls tests (prompts-on-the-table §4.1/§8): the corner cluster's
// single source of truth. The keyboard side of the contract lives in
// shortcuts.test.ts — together they pin the both-read-one-module invariant.

import { describe, expect, it } from 'vitest';
import type { Prompt } from '../src/protocol/protocol';
import { emptyScratch, type PromptStoreState } from '../src/stores/prompt';
import { promptControls } from '../src/state/prompt-controls';

const base = { t: 'game.prompt' as const, seq: 10, gameId: 'g1', promptId: 7, message: 'm' };

const withPrompt = (p?: Prompt, extra: Partial<PromptStoreState> = {}): PromptStoreState =>
  ({ ...emptyScratch(), pending: p, ...extra });

describe('promptControls', () => {
  it('no prompt → no controls', () => {
    expect(promptControls(withPrompt(undefined))).toEqual({});
  });

  it('confirm: primary Yes / secondary No, server texts win', () => {
    const c = promptControls(withPrompt({ ...base, kind: 'confirm' }));
    expect(c.primary).toEqual({ label: 'Yes', answer: { type: 'confirm', value: true }, enabled: true });
    expect(c.secondary).toEqual({ label: 'No', answer: { type: 'confirm', value: false }, enabled: true });
    expect(c.pass).toBeUndefined();

    const texted = promptControls(withPrompt({ ...base, kind: 'confirm', yesText: 'Keep', noText: 'Mulligan' }));
    expect(texted.primary?.label).toBe('Keep');
    expect(texted.secondary?.label).toBe('Mulligan');
  });

  it('plain priority: pass only', () => {
    const c = promptControls(withPrompt({ ...base, kind: 'priority', playable: {}, canPass: true }));
    expect(c.pass).toEqual({ label: 'Pass', answer: { type: 'confirm', value: false }, enabled: true });
    expect(c.primary).toBeUndefined();
    expect(c.secondary).toBeUndefined();
  });

  it('combat priority: Done primary, special when offered, no pass', () => {
    const combat: Prompt = {
      ...base, kind: 'priority', playable: {}, canPass: true,
      combat: { role: 'attackers', candidates: ['c1'], declared: [], special: 'All attack' },
    };
    const c = promptControls(withPrompt(combat));
    expect(c.pass).toBeUndefined();
    expect(c.primary).toEqual({ label: 'Done', answer: { type: 'confirm', value: true }, enabled: true });
    expect(c.special).toEqual({ label: 'All attack', answer: { type: 'option', key: 'special' }, enabled: true });

    const noSpecial: Prompt = {
      ...base, kind: 'priority', playable: {}, canPass: true,
      combat: { role: 'blockers', candidates: [], declared: [] },
    };
    expect(promptControls(withPrompt(noSpecial)).special).toBeUndefined();
  });

  it('chooseTargets: valid Submit > incremental Done > disabled Submit; Decline when declinable', () => {
    const targets: Prompt = { ...base, kind: 'chooseTargets', candidates: ['a', 'b'], min: 1, max: 2, required: true };

    const empty = promptControls(withPrompt(targets));
    expect(empty.primary).toEqual({
      label: 'Submit 0 of 1–2', answer: { type: 'objects', objectIds: [] }, enabled: false });
    expect(empty.secondary).toBeUndefined();   // required, min > 0

    const picked = promptControls(withPrompt(targets, { selected: ['a'] }));
    expect(picked.primary).toEqual({
      label: 'Submit 1 of 1–2', answer: { type: 'objects', objectIds: ['a'] }, enabled: true });

    // incremental flow: server holds ≥ min and the local selection is not a
    // valid submit → Done
    const progress = promptControls(withPrompt({ ...targets, progress: { chosen: 1, of: 2 } }));
    expect(progress.primary).toEqual({ label: 'Done', answer: { type: 'confirm', value: true }, enabled: true });

    // single-target picks answer by click — no primary at all
    const oneClick: Prompt = { ...base, kind: 'chooseTargets', candidates: ['a'], min: 1, max: 1, required: true };
    expect(promptControls(withPrompt(oneClick, { selected: ['a'] })).primary).toBeUndefined();

    // fixed-count label collapses the range
    const exact: Prompt = { ...base, kind: 'chooseTargets', candidates: ['a', 'b'], min: 2, max: 2, required: true };
    expect(promptControls(withPrompt(exact)).primary?.label).toBe('Submit 0 of 2');

    const optional: Prompt = { ...base, kind: 'chooseTargets', candidates: ['a'], min: 0, max: 2, required: false };
    const c = promptControls(withPrompt(optional));
    expect(c.secondary).toEqual({ label: 'Decline', answer: { type: 'cancel' }, enabled: true });
    expect(c.primary?.enabled).toBe(true);     // min 0: empty submit is legal
  });

  it('payMana / chooseOption / distribute: cancel-typed secondary iff declinable', () => {
    expect(promptControls(withPrompt({ ...base, kind: 'payMana', remaining: '{1}', canCancel: true })).secondary)
      .toEqual({ label: 'Cancel', answer: { type: 'cancel' }, enabled: true });
    expect(promptControls(withPrompt({ ...base, kind: 'payMana', remaining: '{1}', canCancel: false })))
      .toEqual({});
    expect(promptControls(withPrompt({ ...base, kind: 'chooseOption', options: [{ key: 'k', text: 't' }], required: false })).secondary?.answer)
      .toEqual({ type: 'cancel' });
    expect(promptControls(withPrompt({ ...base, kind: 'chooseOption', options: [{ key: 'k', text: 't' }] })))
      .toEqual({});
    expect(promptControls(withPrompt({ ...base, kind: 'distribute', total: 4, min: 4, among: [], canCancel: true })).secondary?.answer)
      .toEqual({ type: 'cancel' });
  });

  it('view-owned kinds expose nothing', () => {
    expect(promptControls(withPrompt({ ...base, kind: 'chooseAmount', min: 0, max: 10 }))).toEqual({});
    expect(promptControls(withPrompt({ ...base, kind: 'chooseAbility', options: [] }))).toEqual({});
    expect(promptControls(withPrompt({ ...base, kind: 'choosePile', piles: [[], []] }))).toEqual({});
    expect(promptControls(withPrompt({ ...base, kind: 'playerRequest', requestKey: 'r', options: [] }))).toEqual({});
  });

  it('inflight disables every control but keeps them present', () => {
    const c = promptControls(withPrompt({ ...base, kind: 'confirm' }, { inflight: true }));
    expect(c.primary?.enabled).toBe(false);
    expect(c.secondary?.enabled).toBe(false);
    const pass = promptControls(withPrompt({ ...base, kind: 'priority', playable: {}, canPass: true }, { inflight: true }));
    expect(pass.pass?.enabled).toBe(false);
  });
});
