// The object set a prompt concerns (§7/§8), which drives the §14 camera pull-back:
// if any of these sit off-screen under a manual pin when the prompt becomes
// actionable, the lens pulls back to the whole table. Pure, so asserted directly.

import { describe, expect, it } from 'vitest';
import { emptyScratch, type PromptStoreState } from '@night/core/stores/prompt';
import type { Prompt, StackItem } from '@night/core/protocol/protocol';
import { promptObjectIds, spreadBoardIds, stackTargetIds } from '../src/scene/prompt-objects';

const base = { t: 'game.prompt', seq: 1, gameId: 'g', promptId: 1, message: 'm' } as const;
const ids = (pending: Prompt) => promptObjectIds({ ...emptyScratch(), pending }).sort();
const spread = (pending: Prompt) => spreadBoardIds({ ...emptyScratch(), pending }).sort();

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

describe('spreadBoardIds (#24/#25 un-fold policy)', () => {
  it('nothing pending → nothing spreads', () => {
    expect(spreadBoardIds(emptyScratch())).toEqual([]);
  });

  it('a multi-target ask spreads its candidates — a folded pile dead-ends past its top', () => {
    expect(spread({ ...base, kind: 'chooseTargets', candidates: ['a', 'b'], min: 0, max: 3, required: false }))
      .toEqual(['a', 'b']);
  });

  it('a single-target pick keeps its piles — fold members are fungible by construction', () => {
    expect(spread({ ...base, kind: 'chooseTargets', candidates: ['a', 'b'], min: 1, max: 1, required: true }))
      .toEqual([]);
  });

  it('a combat declaration spreads candidates AND declared (#25)', () => {
    // A declared attacker stays in the grid until Done, so without this the top of
    // a Saproling pile is the only attacker that pile can ever send; `declared` is
    // in the set so toggling one back off is reachable too.
    expect(spread({
      ...base, kind: 'priority', canPass: true, playable: {},
      combat: { role: 'attackers', candidates: ['c1', 'c2'], declared: ['d1'] },
    })).toEqual(['c1', 'c2', 'd1']);
  });

  it('a plain priority window spreads nothing — the board stays folded to play from', () => {
    expect(spread({ ...base, kind: 'priority', canPass: true, playable: { a: [] } })).toEqual([]);
  });

  it('other asks leave the board alone', () => {
    expect(spread({ ...base, kind: 'payMana', remaining: '{G}', sources: ['s'], canCancel: false })).toEqual([]);
    expect(spread({ ...base, kind: 'confirm' })).toEqual([]);
  });
});

describe('stackTargetIds (§14 stack-target framing)', () => {
  const item = (o: Partial<StackItem>): StackItem => ({ id: 'x', kind: 'spell', text: [], ...o });

  it('an empty stack targets nothing', () => {
    expect(stackTargetIds([])).toEqual([]);
  });

  it('collects the targets of every stack item, spell and ability alike', () => {
    expect(stackTargetIds([
      item({ id: 's1', targets: ['a', 'b'] }),        // a modal/removal spell
      item({ id: 's2', kind: 'ability', targets: ['c'] }),
    ])).toEqual(['a', 'b', 'c']);
  });

  it('an untargeted stack (a creature being cast, an ETB) contributes nothing', () => {
    // This is the "don't zoom out for a plain cast" guarantee, at the source.
    expect(stackTargetIds([item({ id: 'creature' }), item({ id: 'etb', kind: 'ability', targets: [] })]))
      .toEqual([]);
  });
});
