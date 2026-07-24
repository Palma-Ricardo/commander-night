// The object set a prompt concerns (§7/§8), which drives the §14 camera pull-back:
// if any of these sit off-screen under a manual pin when the prompt becomes
// actionable, the lens pulls back to the whole table. Pure, so asserted directly.

import { describe, expect, it } from 'vitest';
import { emptyScratch, type PromptStoreState } from '@night/core/stores/prompt';
import type { Prompt } from '@night/core/protocol/protocol';
import { promptObjectIds } from '../src/scene/prompt-objects';

const base = { t: 'game.prompt', seq: 1, gameId: 'g', promptId: 1, message: 'm' } as const;
const ids = (pending: Prompt) => promptObjectIds({ ...emptyScratch(), pending }).sort();

describe('promptObjectIds (§14 pull-back scope)', () => {
  it('no pending prompt → no objects', () => {
    expect(promptObjectIds(emptyScratch())).toEqual([]);
  });

  it('a plain priority window scopes nothing — you can pass, and your hand is always in shot', () => {
    // NOT its playables: scoping by them pulled the lens to the table on every respond
    // window (an opponent casting a creature, an ETB) while you followed their seat.
    expect(ids({ ...base, kind: 'priority', canPass: true, playable: { a: [], b: [] } })).toEqual([]);
  });

  it('priority + combat names candidates and already-declared', () => {
    expect(ids({
      ...base, kind: 'priority', canPass: true, playable: {},
      combat: { role: 'attackers', candidates: ['x'], declared: ['y'] },
    })).toEqual(['x', 'y']);
  });

  it('chooseTargets names its candidates', () => {
    expect(ids({ ...base, kind: 'chooseTargets', candidates: ['t1', 't2'], min: 1, max: 1, required: true }))
      .toEqual(['t1', 't2']);
  });

  it('payMana names its sources (empty when none)', () => {
    expect(ids({ ...base, kind: 'payMana', remaining: '{G}', sources: ['s'], canCancel: false })).toEqual(['s']);
    expect(ids({ ...base, kind: 'payMana', remaining: '{G}', canCancel: false })).toEqual([]);
  });

  it('chooseAbility names its source (empty when off-board)', () => {
    expect(ids({ ...base, kind: 'chooseAbility', sourceId: 'src', options: [] })).toEqual(['src']);
    expect(ids({ ...base, kind: 'chooseAbility', options: [] })).toEqual([]);
  });

  it('a plain confirm concerns no board object', () => {
    expect(ids({ ...base, kind: 'confirm' })).toEqual([]);
  });
});
