// resolveShortcut tests (design §7 bindings). Pure — no DOM, no React.

import { describe, expect, it } from 'vitest';
import type { Prompt } from '../src/protocol/protocol';
import { emptyScratch, type PromptStoreState } from '../src/stores/prompt';
import { resolveShortcut } from '../src/state/shortcuts';

const base = { t: 'game.prompt' as const, seq: 10, gameId: 'g1', promptId: 7, message: 'm' };

const withPrompt = (p?: Prompt, extra: Partial<PromptStoreState> = {}): PromptStoreState =>
  ({ ...emptyScratch(), pending: p, ...extra });

const priority: Prompt = { ...base, kind: 'priority', playable: {}, canPass: true };
const combat: Prompt = {
  ...base, kind: 'priority', playable: {}, canPass: true,
  combat: { role: 'attackers', candidates: ['c1'], declared: [], special: 'All attack' },
};

describe('resolveShortcut', () => {
  it('Space passes priority — but never during combat declaration', () => {
    expect(resolveShortcut(' ', withPrompt(priority), false)).toEqual(
      { do: 'answer', promptId: 7, answer: { type: 'confirm', value: false } });
    expect(resolveShortcut(' ', withPrompt(combat), false)).toBeUndefined();
    expect(resolveShortcut(' ', withPrompt(undefined), false)).toBeUndefined();
  });

  it('Enter: confirm-yes, combat Done, and chooseTargets submit when valid', () => {
    const confirm: Prompt = { ...base, kind: 'confirm' };
    expect(resolveShortcut('Enter', withPrompt(confirm), false)).toEqual(
      { do: 'answer', promptId: 7, answer: { type: 'confirm', value: true } });
    expect(resolveShortcut('Enter', withPrompt(combat), false)).toEqual(
      { do: 'answer', promptId: 7, answer: { type: 'confirm', value: true } });

    const targets: Prompt = { ...base, kind: 'chooseTargets', candidates: ['a', 'b'], min: 1, max: 2, required: true };
    expect(resolveShortcut('Enter', withPrompt(targets), false)).toBeUndefined();   // 0 selected
    expect(resolveShortcut('Enter', withPrompt(targets, { selected: ['a'] }), false)).toEqual(
      { do: 'answer', promptId: 7, answer: { type: 'objects', objectIds: ['a'] } });

    // min 0 with nothing selected is a legal submit — mirrors the enabled dock button
    const optional: Prompt = { ...base, kind: 'chooseTargets', candidates: ['a'], min: 0, max: 2, required: false };
    expect(resolveShortcut('Enter', withPrompt(optional), false)).toEqual(
      { do: 'answer', promptId: 7, answer: { type: 'objects', objectIds: [] } });

    // max 1 renders no Submit button (single click answers) — Enter stays inert
    const oneClick: Prompt = { ...base, kind: 'chooseTargets', candidates: ['a'], min: 1, max: 1, required: true };
    expect(resolveShortcut('Enter', withPrompt(oneClick, { selected: ['a'] }), false)).toBeUndefined();

    // incremental flow: server already holds ≥ min → Done
    const progress: Prompt = { ...targets, progress: { chosen: 1, of: 2 } };
    expect(resolveShortcut('Enter', withPrompt(progress), false)).toEqual(
      { do: 'answer', promptId: 7, answer: { type: 'confirm', value: true } });
  });

  it('Escape declines only true cancels — never confirm-No', () => {
    const cancelable: Prompt = { ...base, kind: 'payMana', remaining: '{1}', canCancel: true };
    const forced: Prompt = { ...base, kind: 'payMana', remaining: '{1}', canCancel: false };
    const confirm: Prompt = { ...base, kind: 'confirm' };
    const option: Prompt = { ...base, kind: 'chooseOption', options: [{ key: 'k', text: 't' }], required: false };
    expect(resolveShortcut('Escape', withPrompt(cancelable), false)).toEqual(
      { do: 'answer', promptId: 7, answer: { type: 'cancel' } });
    expect(resolveShortcut('Escape', withPrompt(forced), false)).toBeUndefined();
    expect(resolveShortcut('Escape', withPrompt(confirm), false)).toBeUndefined();
    expect(resolveShortcut('Escape', withPrompt(option), false)).toEqual(
      { do: 'answer', promptId: 7, answer: { type: 'cancel' } });
  });

  it('F4/F6 are skips regardless of a pending prompt', () => {
    expect(resolveShortcut('F4', withPrompt(undefined), false)).toEqual(
      { do: 'action', action: { kind: 'skip', mode: 'endOfTurn' } });
    expect(resolveShortcut('F6', withPrompt(priority), false)).toEqual(
      { do: 'action', action: { kind: 'skip', mode: 'myNextTurn' } });
  });

  it('A fires the combat special only when offered', () => {
    expect(resolveShortcut('a', withPrompt(combat), false)).toEqual(
      { do: 'answer', promptId: 7, answer: { type: 'option', key: 'special' } });
    const noSpecial: Prompt = {
      ...base, kind: 'priority', playable: {}, canPass: true,
      combat: { role: 'blockers', candidates: [], declared: [] },
    };
    expect(resolveShortcut('A', withPrompt(noSpecial), false)).toBeUndefined();
    expect(resolveShortcut('a', withPrompt(priority), false)).toBeUndefined();
  });

  it('suspends answers while inflight and everything after game over', () => {
    expect(resolveShortcut(' ', withPrompt(priority, { inflight: true }), false)).toBeUndefined();
    expect(resolveShortcut('F4', withPrompt(undefined), true)).toBeUndefined();
    expect(resolveShortcut(' ', withPrompt(priority), true)).toBeUndefined();
  });
});
