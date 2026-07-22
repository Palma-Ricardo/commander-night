// Keyboard shortcut resolution (design §7): Space pass (priority without
// combat only), Enter primary affirmative, Esc cancel/decline, F4 end of
// turn, F6 my next turn, A all-attack when offered. Pure and React-free —
// ui/shortcuts.ts wires it to document keydown.
//
// Answer effects capture the promptId they resolved against (§7) and go
// through answerPrompt, which drops them if the prompt moved on. Esc maps
// only to true {cancel} answers — never confirm-No: declining a mulligan or
// a "sacrifice?" ask from a stray keypress is exactly the kind of surprise
// the §7 fencing exists to prevent.

import type { AnswerValue, GameActionValue } from '../protocol/protocol';
import type { PromptStoreState } from '../stores/prompt';

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
  const answer = (a: AnswerValue): ShortcutEffect | undefined =>
    p === undefined || prompt.inflight ? undefined : { do: 'answer', promptId: p.promptId, answer: a };

  switch (key) {
    case ' ':
      return p?.kind === 'priority' && p.combat === undefined
        ? answer({ type: 'confirm', value: false })
        : undefined;

    case 'Enter': {
      if (p === undefined) return undefined;
      if (p.kind === 'confirm') return answer({ type: 'confirm', value: true });
      if (p.kind === 'priority' && p.combat !== undefined) return answer({ type: 'confirm', value: true });
      if (p.kind === 'chooseTargets') {
        // mirror the dock Submit's enabled logic exactly (§7) — min 0 with an
        // empty selection is a legal submit, same as the enabled button
        const k = prompt.selected.length;
        if (p.max !== 1 && k >= p.min && k <= p.max) {
          return answer({ type: 'objects', objectIds: prompt.selected });
        }
        if (p.progress !== undefined && p.progress.chosen >= p.min) {
          return answer({ type: 'confirm', value: true });   // incremental-flow Done
        }
      }
      return undefined;
    }

    case 'Escape': {
      if (p === undefined) return undefined;
      const declinable =
        (p.kind === 'payMana' && p.canCancel)
        || (p.kind === 'chooseOption' && p.required === false)
        || (p.kind === 'chooseTargets' && (!p.required || p.min === 0))
        || (p.kind === 'distribute' && p.canCancel === true);
      return declinable ? answer({ type: 'cancel' }) : undefined;
    }

    case 'F4':
      return { do: 'action', action: { kind: 'skip', mode: 'endOfTurn' } };
    case 'F6':
      return { do: 'action', action: { kind: 'skip', mode: 'myNextTurn' } };

    case 'a':
    case 'A':
      return p?.kind === 'priority' && p.combat?.special !== undefined
        ? answer({ type: 'option', key: 'special' })
        : undefined;

    default:
      return undefined;
  }
}
