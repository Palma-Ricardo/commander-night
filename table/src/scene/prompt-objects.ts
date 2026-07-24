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

import type { Id } from '@night/core/protocol/protocol';
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
