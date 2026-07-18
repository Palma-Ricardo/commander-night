// Click routing for board objects (§7): what a click on an object means is
// derived from the pending prompt's affordance, never from state. Multi-action
// popovers call answerObject directly; everything else funnels through
// objectClick.

import { appActions } from '../../app';
import type { Id } from '../../protocol/protocol';
import { affordanceFor } from '../../state/selectors';
import type { PromptStoreState } from '../../stores/prompt';

export function answerObject(promptId: number, objectId: Id): void {
  void appActions.answerPrompt(promptId, { type: 'object', objectId });
}

/** Handle a plain click on an object. Returns true when the click was consumed
 *  (callers with their own popover logic check the affordance first). */
export function objectClick(prompt: PromptStoreState, objectId: Id): boolean {
  const p = prompt.pending;
  if (p === undefined || prompt.inflight) return false;
  const aff = affordanceFor(prompt, objectId);
  if (aff === undefined) return false;
  switch (aff.kind) {
    case 'action':
      answerObject(p.promptId, objectId);
      return true;
    case 'manaOnly':
      return false;   // never a click target (§7) — context menu only
    case 'target':
      // single-target picks answer in one click (§8 allows {object} one-at-a-time);
      // multi-target accumulates scratch and submits whole (§7)
      if (p.kind === 'chooseTargets' && p.max === 1) answerObject(p.promptId, objectId);
      else appActions.toggleTarget(p.promptId, objectId);
      return true;
    case 'source':
      void appActions.clickManaSource(p.promptId, objectId);
      return true;
    case 'combatCandidate':
    case 'combatDeclared':
      // one toggle per round trip; the re-fired prompt re-renders the board (§8)
      answerObject(p.promptId, objectId);
      return true;
  }
}
