// What the inspect sheet offers for a card (mobile plan §3) — pure over the
// shared affordance model, so the button set is unit-tested headlessly. Every
// button answers through the same router a felt click does (interact.ts), so
// the sheet adds no new meaning: it is the deliberate second step a touch tap
// needs, and the mana-ability menu the canvas never had.

import type { Affordance, PlayableAction } from '@night/core/state/selectors';

export type InspectVerb = 'click' | 'mana';

export interface InspectButton {
  label: string;
  /** 'click' → interact.objectClick (the felt-click meaning, incl. casting);
   *  'mana' → answer the object directly — a mana-only card is never a click
   *  target (§7), so this is the only path that fires its ability. */
  verb: InspectVerb;
  primary: boolean;
}

/** The verb a play action reads as, from its kinds — "Cast" a spell, "Play" a
 *  land, "Activate" an ability; mixed kinds fall back to a neutral "Use" and the
 *  server's own ability picker (AbilityOptions) disambiguates. */
function playLabel(actions: PlayableAction[]): string {
  const kinds = new Set(actions.filter(a => a.kind !== 'mana').map(a => a.kind));
  if (kinds.size !== 1) return 'Use…';
  const [k] = kinds;
  return k === 'cast' ? 'Cast' : k === 'play' ? 'Play' : 'Activate';
}

export function inspectButtons(aff: Affordance | undefined, inflight: boolean): InspectButton[] {
  if (aff === undefined || inflight) return [];
  switch (aff.kind) {
    // A card with mana *and* other abilities answers one object either way and the
    // server's own picker lists all of them, so a separate mana button would only
    // duplicate this one.
    case 'action': return [{ label: playLabel(aff.actions), verb: 'click', primary: true }];
    case 'manaOnly': return [{ label: 'Tap for mana', verb: 'mana', primary: true }];
    case 'target': return [{ label: aff.selected === true ? 'Unselect target' : 'Choose as target', verb: 'click', primary: true }];
    // A cantPay source still clicks on the felt (it is only dimmed), so it keeps its button.
    case 'source': return [{ label: 'Pay with this', verb: 'click', primary: !aff.cantPay }];
    case 'combatCandidate':
      return [{ label: aff.role === 'attackers' ? 'Attack' : 'Block', verb: 'click', primary: true }];
    case 'combatDeclared':
      return [{ label: aff.role === 'attackers' ? 'Remove attacker' : 'Remove blocker', verb: 'click', primary: true }];
  }
}
