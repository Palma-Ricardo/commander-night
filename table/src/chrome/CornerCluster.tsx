// The corner cluster (prompts-on-the-table §4.1): the fixed bottom-right home
// for prompt confirmation. An always-visible Pass — its constant presence is
// the priority indicator, enabled exactly when a plain priority ask is
// pending — plus the contextual primary/secondary/special for the kinds that
// have moved off the dock (T7: confirm, priority incl. combat controls,
// chooseAmount; T8: board-reachable chooseTargets). Everything resolves
// through promptControls, the same module the keyboard reads (§8), so a
// button and its key can never disagree.
//
// Strangler discipline: a control renders in exactly one place per prompt.
// Unmigrated bodies keep their controls in PromptDock until their milestone;
// dockOwns (migration.ts) is the single split both components read, so
// primary/secondary/special here are gated on it even though the module
// computes them for every kind.

import { useStore } from 'zustand';
import { appActions, appStores } from '../app';
import { promptControls, type ControlSpec } from '@night/core/state/prompt-controls';
import { amountStore } from './amount-store';
import { dockOwns } from './migration';

export function CornerCluster() {
  const prompt = useStore(appStores.prompt);
  const over = useStore(appStores.game, s => s.over !== undefined);
  const state = useStore(appStores.game, s => s.state);
  const draft = useStore(amountStore, s => s.draft);
  if (over) return null;

  const p = prompt.pending;
  const controls = promptControls(prompt);
  const owned = p !== undefined && !dockOwns(p, state);
  const busy = prompt.inflight && owned;

  const fire = (c: ControlSpec) => {
    if (p !== undefined && c.enabled) void appActions.answerPrompt(p.promptId, c.answer);
  };

  // chooseAmount: the OK's value comes from the screen-space selector's draft
  // (amount-store) — promptControls deliberately owns no local-input answers.
  const amountOk = p?.kind === 'chooseAmount'
    && draft?.promptId === p.promptId
    && draft.value >= p.min && draft.value <= p.max;

  return (
    <div className={`corner-cluster${busy ? ' dock-busy' : ''}`}>
      {owned && controls.special !== undefined && (
        <button data-answer="special" disabled={!controls.special.enabled}
          onClick={() => fire(controls.special!)}>
          {controls.special.label} <kbd>A</kbd>
        </button>
      )}
      {owned && controls.secondary !== undefined && (
        <button data-answer="secondary" disabled={!controls.secondary.enabled}
          onClick={() => fire(controls.secondary!)}>
          {controls.secondary.label}
        </button>
      )}
      {owned && controls.primary !== undefined && (
        <button className="primary" data-answer="primary" disabled={!controls.primary.enabled}
          onClick={() => fire(controls.primary!)}>
          {controls.primary.label}
        </button>
      )}
      {p?.kind === 'chooseAmount' && (
        <button className="primary" data-answer="ok" disabled={prompt.inflight || !amountOk}
          onClick={() => {
            if (amountOk) void appActions.answerPrompt(p.promptId, { type: 'number', value: draft.value });
          }}>
          OK
        </button>
      )}
      <button className={controls.pass !== undefined ? 'primary pass-btn' : 'pass-btn'}
        data-answer="pass"
        disabled={controls.pass === undefined || !controls.pass.enabled}
        onClick={() => { if (controls.pass !== undefined) fire(controls.pass); }}>
        Pass <kbd>Space</kbd>
      </button>
      {busy && <span className="badge-spinner dock-spinner" aria-label="waiting for server" />}
    </div>
  );
}
