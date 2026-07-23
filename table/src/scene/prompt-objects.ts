// The set of object ids a pending prompt concerns (§7/§8) — the cards the player
// is being asked about. The scene uses it for the §14 camera pull-back: if any of
// these sit off-screen under a manually-pinned camera when the prompt becomes
// actionable, the lens pulls back to the whole table (the one preset that can
// never be wrong). Pure and headless — no Pixi, no camera. Highlighting itself
// does not need this list (the scene tests each actor with affordanceFor); this
// is only "which objects must be visible".

import type { Id } from '@night/core/protocol/protocol';
import type { PromptStoreState } from '@night/core/stores/prompt';

export function promptObjectIds(prompt: PromptStoreState): Id[] {
  const p = prompt.pending;
  if (p === undefined) return [];
  switch (p.kind) {
    case 'priority': {
      if (p.combat !== undefined) return [...p.combat.candidates, ...p.combat.declared];
      return Object.keys(p.playable);
    }
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
