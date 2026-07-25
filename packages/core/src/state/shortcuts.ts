// Keyboard shortcut resolution (design §7): Space pass (priority without
// combat only), Enter primary affirmative, Esc cancel/decline, F4 end of
// turn, F6 my next turn, A all-attack when offered. Pure and React-free —
// each client's chrome wires it to document keydown.
//
// Since prompts-on-the-table §8, the prompt-answering keys resolve through
// promptControls — the same module the corner cluster renders from — so a
// key and its button are structurally one meaning: Space is the pass
// control, Enter is the primary, A is the special. Esc fires the secondary
// only when its answer is a true {cancel} — never confirm-No: declining a
// mulligan or a "sacrifice?" ask from a stray keypress is exactly the kind
// of surprise the §7 fencing exists to prevent.
//
// Answer effects capture the promptId they resolved against (§7) and go
// through answerPrompt, which drops them if the prompt moved on.

import type { AnswerValue, GameActionValue } from '../protocol/protocol';
import type { PromptStoreState } from '../stores/prompt';
import { promptControls, type ControlSpec } from './prompt-controls';

export type ShortcutEffect =
  | { do: 'answer'; promptId: number; answer: AnswerValue }
  | { do: 'action'; action: GameActionValue };

export function resolveShortcut(
  key: string,
  prompt: PromptStoreState,
  gameOver: boolean,
): ShortcutEffect | undefined {
  if (gameOver) return undefined;
  const p = prompt.pending;
  const controls = promptControls(prompt);
  const fire = (c: ControlSpec | undefined): ShortcutEffect | undefined =>
    c !== undefined && c.enabled && p !== undefined
      ? { do: 'answer', promptId: p.promptId, answer: c.answer }
      : undefined;

  switch (key) {
    case ' ':
      return fire(controls.pass);

    case 'Enter':
      return fire(controls.primary);

    case 'Escape':
      return controls.secondary?.answer.type === 'cancel' ? fire(controls.secondary) : undefined;

    case 'F4':
      return { do: 'action', action: { kind: 'skip', mode: 'endOfTurn' } };
    case 'F6':
      return { do: 'action', action: { kind: 'skip', mode: 'myNextTurn' } };

    case 'a':
    case 'A':
      return fire(controls.special);

    default:
      return undefined;
  }
}
