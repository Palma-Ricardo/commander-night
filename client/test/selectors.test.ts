// Derived-state selectors (design §13 unit tier): status line (incl. mulligan
// fallback and prompt takeover), seat split, object lookup, commander-damage
// matrix, and the §7 prompt-driven affordances.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decode } from '../src/protocol/codec';
import type { GameState, Prompt, StateKeyframe } from '../src/protocol/protocol';
import {
  affordanceFor, combatLines, commanderDamageRows, findObject, me, opponents, statusLine, targetName,
} from '../src/state/selectors';
import { emptyScratch, type PromptStoreState } from '../src/stores/prompt';

function sample<T>(name: string): T {
  const text = fs.readFileSync(
    fileURLToPath(new URL(`../../docs/protocol/samples/${name}`, import.meta.url)), 'utf8');
  const r = decode(text, { strict: true });
  if (!r.ok || r.msg === null) throw new Error(`sample ${name} did not decode`);
  return r.msg as T;
}

const state = (): GameState =>
  structuredClone(sample<StateKeyframe>('game.state.json').state);

const scratchWith = (over: Partial<PromptStoreState>): PromptStoreState =>
  ({ ...emptyScratch(), ...over });

describe('players', () => {
  it('me/opponents split preserves seat rotation', () => {
    const s = state();
    expect(me(s)?.name).toBe('Ricardo');
    expect(opponents(s).map(p => p.name)).toEqual(['ai_1']);
  });
});

describe('object lookup', () => {
  it('finds cards across zones', () => {
    const s = state();
    expect(findObject(s, 'perm-1')?.name).toBe('Command Tower');
    expect(findObject(s, 'gy-1')?.name).toBe('Arcane Signet');
    expect(findObject(s, 'cmd-1')?.name).toBe('Lathril, Blade of the Elves');
    expect(findObject(s, 'hand-1')?.name).toBe('Elvish Mystic');
    expect(findObject(s, 'stack-1')?.name).toBe('Reality Shift');
    expect(findObject(s, 'nope')).toBeUndefined();
  });

  it('targetName prefers players, falls back to objects', () => {
    const s = state();
    expect(targetName(s, 'p2')).toBe('ai_1');
    expect(targetName(s, 'perm-1')).toBe('Command Tower');
    expect(targetName(s, 'gone')).toBe('unknown target');
  });
});

describe('statusLine', () => {
  it('derives step + waiting-for from state (protocol §2)', () => {
    expect(statusLine(state())).toBe('T3 · First main — waiting for Ricardo');
  });

  it('a pending prompt message takes over', () => {
    expect(statusLine(state(), 'Pay {1}{U}')).toBe('Pay {1}{U}');
  });

  it('falls back to Mulligans while turn structure is absent (§6)', () => {
    const s = state();
    delete s.turn.phase;
    delete s.turn.step;
    delete s.turn.activePlayerId;
    delete s.turn.priorityPlayerId;
    expect(statusLine(s)).toBe('Mulligans');
  });
});

describe('commander damage (data on the victim, §6)', () => {
  it('resolves commander names from any zone', () => {
    const s = state();
    const victim = s.players.find(p => p.id === 'p2')!;
    expect(commanderDamageRows(s, victim)).toEqual([
      { commander: 'Lathril, Blade of the Elves', amount: 5 },
    ]);
  });

  it('empty when absent', () => {
    const s = state();
    expect(commanderDamageRows(s, s.players[0]!)).toEqual([]);
  });
});

describe('combatLines', () => {
  it('renders attacker → defender with blockers', () => {
    const s = state();
    s.combat = [{ attackerIds: ['perm-1'], defenderId: 'p2', blockerIds: [], blocked: false }];
    expect(combatLines(s)).toEqual(['Command Tower → ai_1']);
  });
});

describe('affordanceFor (§7)', () => {
  const priority = sample<Prompt>('game.prompt.priority.json');

  it('priority: non-mana actions highlight; mana-only never does', () => {
    const scratch = scratchWith({ pending: priority });
    const aff = affordanceFor(scratch, '3f2a9d1e-6c47-4b2e-9a10-8e5d21f7b0c4');
    expect(aff).toMatchObject({ kind: 'action' });

    const manaOnly = {
      ...priority,
      playable: { 'land-9': [{ kind: 'mana' as const, text: '{T}: Add {G}.' }] },
    };
    expect(affordanceFor(scratchWith({ pending: manaOnly }), 'land-9'))
      .toMatchObject({ kind: 'manaOnly' });
    expect(affordanceFor(scratchWith({ pending: manaOnly }), 'other')).toBeUndefined();
  });

  it('combat: candidates and declared toggle affordances; playable ignored', () => {
    const combat = sample<Prompt>('game.prompt.priority.combat.json');
    const scratch = scratchWith({ pending: combat });
    if (combat.kind !== 'priority' || combat.combat === undefined) throw new Error('bad sample');
    const cand = combat.combat.candidates[0]!;
    expect(affordanceFor(scratch, cand)).toEqual({ kind: 'combatCandidate', role: combat.combat.role });
    for (const d of combat.combat.declared) {
      expect(affordanceFor(scratch, d)).toEqual({ kind: 'combatDeclared', role: combat.combat.role });
    }
  });

  it('chooseTargets: candidates carry selection state', () => {
    const targets = sample<Prompt>('game.prompt.chooseTargets.json');
    const scratch = scratchWith({ pending: targets, selected: ['aaa-1'] });
    expect(affordanceFor(scratch, 'aaa-1')).toEqual({ kind: 'target', selected: true });
    expect(affordanceFor(scratch, 'bbb-2')).toEqual({ kind: 'target', selected: false });
    expect(affordanceFor(scratch, 'zzz')).toBeUndefined();
  });

  it('payMana: sources highlight, cantPay flows through', () => {
    const pay = sample<Prompt>('game.prompt.payMana.json');
    const scratch = scratchWith({ pending: pay, cantPay: ['land-2'] });
    expect(affordanceFor(scratch, 'land-1')).toEqual({ kind: 'source', cantPay: false });
    expect(affordanceFor(scratch, 'land-2')).toEqual({ kind: 'source', cantPay: true });
  });

  it('no pending prompt → no affordances anywhere', () => {
    expect(affordanceFor(scratchWith({}), 'perm-1')).toBeUndefined();
  });
});
