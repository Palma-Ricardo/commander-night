// The set of object ids a pending prompt concerns *and that the player must be able
// to see to act* (§7/§8). The scene uses it for the §14 camera pull-back: if any of
// these sit off-screen under the current view, the lens pulls back to the whole
// table (the one preset that can never be wrong). Pure and headless — no Pixi, no
// camera. Highlighting itself does not need this list (the scene tests each actor
// with affordanceFor); this is only "which objects must be visible".
//
// Scope it to prompts that genuinely *require* seeing a specific board object — a
// forced choice among candidates, a source, a combat declaration. A plain priority
// window is NOT one of them: you can always pass, and your hand (the playables that
// matter) is a screen-space fan that is visible at every zoom. Scoping priority by
// its whole `playable` map pulled the lens to the table on every ordinary respond
// window — an opponent casting a creature, an ETB — because your own board sits
// off-screen while you follow *their* seat, and it re-fired the moment you passed,
// so even Esc bounced straight back (reported 2026-07-23). Combat declaration stays
// scoped: declaring blockers spans the attacker's board and yours, which is exactly
// when a pull-back earns its keep.

import type { Id, StackItem } from '@night/core/protocol/protocol';
import type { PromptStoreState } from '@night/core/stores/prompt';

export function promptObjectIds(prompt: PromptStoreState): Id[] {
  const p = prompt.pending;
  if (p === undefined) return [];
  switch (p.kind) {
    case 'priority':
      // Only a combat declaration scopes the camera; a plain priority window does not.
      return p.combat !== undefined ? [...p.combat.candidates, ...p.combat.declared] : [];
    case 'chooseTargets':
      return [...p.candidates];
    case 'payMana':
      return p.sources ?? [];
    case 'chooseAbility':
      return p.sourceId !== undefined ? [p.sourceId] : [];
    default:
      return [];
  }
}

/** Every object/player id that anything on the stack targets — the second input to
 *  the §14 pull-back, orthogonal to any prompt. A targeted effect that reaches off
 *  the framed board (the active player casting removal at another seat's creature
 *  while you follow the caster) must widen the lens to the whole table rather than
 *  resolve off-screen. "Any effect that targets," across the whole stack; an
 *  untargeted spell (a creature being cast, an ETB) contributes nothing, so a plain
 *  cast never pulls back. Which of these actually *forces* a pull-back is decided in
 *  the scene, by whether each target's board anchor is visible under the current
 *  view — a target on the framed player's own board is already in shot. */
export function stackTargetIds(stack: readonly StackItem[]): Id[] {
  const out: Id[] = [];
  for (const item of stack) if (item.targets !== undefined) out.push(...item.targets);
  return out;
}
