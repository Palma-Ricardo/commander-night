// Prompt-control resolution (prompts-on-the-table §4.1/§8): the single source
// of truth for the corner cluster's controls — which exist for the pending
// prompt, their labels, answers, and enabled state. resolveShortcut consumes
// this same module, so the keyboard and the buttons can never disagree:
// Space IS pass, Enter IS the primary, Escape IS a cancel-typed secondary,
// A IS the combat special. Pure and React-free, like everything in state/.
//
// Controls whose answer needs view-local input (chooseAmount's value,
// distribute's row amounts) are deliberately absent here — the view owns
// them, exactly as the keyboard has always ignored them.

import type { AnswerValue } from '../protocol/protocol';
import type { PromptStoreState } from '../stores/prompt';

export interface ControlSpec {
  label: string;
  answer: AnswerValue;
  enabled: boolean;
}

export interface PromptControls {
  /** The always-visible Pass button's live half: present ⇔ a plain priority
   *  ask is pending. The cluster renders the button regardless (its constant
   *  presence is the priority indicator); absent here means disabled. */
  pass?: ControlSpec;
  /** Contextual affirmative: confirm Yes, combat Done, chooseTargets
   *  Submit-when-valid falling back to incremental Done. At most one — the
   *  corner has one primary, and Enter needs one meaning. */
  primary?: ControlSpec;
  /** Contextual negative: confirm No, or a Decline/Cancel. Escape fires it
   *  only when its answer is a true {cancel} — never confirm-No (§7's
   *  stray-keypress rule), which the cluster still renders as a button. */
  secondary?: ControlSpec;
  /** XMage's combat shortcut when offered (e.g. "All attack"). */
  special?: ControlSpec;
}

export function promptControls(prompt: PromptStoreState): PromptControls {
  const p = prompt.pending;
  if (p === undefined) return {};
  const ok = !prompt.inflight;

  switch (p.kind) {
    case 'confirm':
      return {
        primary: { label: p.yesText ?? 'Yes', answer: { type: 'confirm', value: true }, enabled: ok },
        secondary: { label: p.noText ?? 'No', answer: { type: 'confirm', value: false }, enabled: ok },
      };

    case 'priority': {
      if (p.combat === undefined) {
        return { pass: { label: 'Pass', answer: { type: 'confirm', value: false }, enabled: ok } };
      }
      const controls: PromptControls = {
        primary: { label: 'Done', answer: { type: 'confirm', value: true }, enabled: ok },
      };
      if (p.combat.special !== undefined) {
        controls.special = { label: p.combat.special, answer: { type: 'option', key: 'special' }, enabled: ok };
      }
      return controls;
    }

    case 'chooseTargets': {
      const k = prompt.selected.length;
      const controls: PromptControls = {};
      if (!p.required || p.min === 0) {
        controls.secondary = { label: 'Decline', answer: { type: 'cancel' }, enabled: ok };
      }
      // Primary: a valid whole-set Submit wins; the incremental-flow Done
      // (server already holds ≥ min, §8) is the fallback; an out-of-range
      // Submit still renders, disabled, so the counter stays visible.
      const inRange = k >= p.min && k <= p.max;
      const submitLabel = () =>
        `Submit ${k} of ${p.min === p.max ? String(p.min) : `${p.min}–${p.max}`}`;
      if (p.max !== 1 && inRange) {
        controls.primary = { label: submitLabel(), answer: { type: 'objects', objectIds: prompt.selected }, enabled: ok };
      } else if (p.progress !== undefined && p.progress.chosen >= p.min) {
        controls.primary = { label: 'Done', answer: { type: 'confirm', value: true }, enabled: ok };
      } else if (p.max !== 1) {
        controls.primary = { label: submitLabel(), answer: { type: 'objects', objectIds: prompt.selected }, enabled: false };
      }
      return controls;
    }

    case 'payMana':
      return p.canCancel
        ? { secondary: { label: 'Cancel', answer: { type: 'cancel' }, enabled: ok } }
        : {};

    case 'chooseOption':
      return p.required === false
        ? { secondary: { label: 'Decline', answer: { type: 'cancel' }, enabled: ok } }
        : {};

    case 'distribute':
      return p.canCancel === true
        ? { secondary: { label: 'Cancel', answer: { type: 'cancel' }, enabled: ok } }
        : {};

    // chooseAbility / chooseOption lists, choosePile picks, chooseAmount OK and
    // playerRequest options are all view-owned (option lists or local input).
    default:
      return {};
  }
}
