// The pending-intent buffer's consumer (prompts-on-the-table §4.3). Some
// gestures span round trips: declaring an attacker sends `{object}` on the
// press, but *whom it attacks* arrives as a separate follow-up chooseTargets.
// The drag release records the intended target in the prompt store
// (`intent`, written via actions.pointTarget); this module watches for the
// next prompt and answers it when — and only when — it matches.
//
// Fencing philosophy (same as promptId capture, §7, one prompt into the
// future): the intent is consumed-or-dropped on the FIRST prompt to arrive
// after it was recorded. A match is strict — a single-pick chooseTargets
// whose candidates include the exact id. Anything else drops the intent
// silently: the failure mode is *not answering* (the prompt renders and the
// player clicks), never answering the wrong question. promptDone alone does
// not expire it — the follow-up ask lands after the toggle's done.

import type { AnswerValue, Id } from '../protocol/protocol';
import type { PromptStoreState } from '../stores/prompt';

type PromptStore = {
  getState(): PromptStoreState;
  setState(partial: Partial<PromptStoreState>): void;
  subscribe(listener: (s: PromptStoreState) => void): () => void;
};

/** The auto-answer a just-arrived prompt earns from the buffered intent, or
 *  undefined (pure — the wiring below owns the clear-and-send). */
export function intentAnswer(
  s: PromptStoreState,
): { promptId: number; answer: AnswerValue } | undefined {
  const p = s.pending;
  const intent = s.intent;
  if (p === undefined || intent === undefined) return undefined;
  if (p.kind !== 'chooseTargets' || p.max !== 1) return undefined;
  if (!p.candidates.includes(intent.targetId)) return undefined;
  return { promptId: p.promptId, answer: { type: 'object', objectId: intent.targetId } };
}

/** Subscribe the consumer to the prompt store. Every *new* pending promptId
 *  consumes the buffer: matching intents answer immediately, everything else
 *  is dropped. Returns the unsubscribe. */
export function wireIntentBuffer(
  store: PromptStore,
  answer: (promptId: number, a: AnswerValue) => void,
): () => void {
  let lastPromptId = store.getState().pending?.promptId;
  return store.subscribe(s => {
    const pid = s.pending?.promptId;
    if (pid === lastPromptId) return;
    lastPromptId = pid;
    if (pid === undefined) return;              // promptDone — the buffer waits for the ask
    if (s.intent === undefined) return;
    const hit = intentAnswer(s);
    store.setState({ intent: undefined });      // consumed or dropped — never held across prompts
    if (hit !== undefined) answer(hit.promptId, hit.answer);
  });
}
