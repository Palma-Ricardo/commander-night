// The corner cluster (prompts-on-the-table §4.1): the fixed bottom-right home
// for prompt confirmation. An always-visible Pass — its constant presence is
// the priority indicator, enabled exactly when a plain priority ask is
// pending — plus the contextual primary/secondary/special for the pending
// kind. Everything resolves through promptControls, the same module the
// keyboard reads (§8), so a button and its key can never disagree. Since T9
// deleted the dock, every prompt kind confirms here; the two answers that
// need view-local input (chooseAmount's value, distribute's row amounts) read
// their drafts from amount-store / distribute-store — promptControls
// deliberately owns no local-input answers.

import { useStore } from 'zustand';
import { appActions, appStores } from '../app';
import { promptControls, type ControlSpec } from '@night/core/state/prompt-controls';
import { amountStore } from './amount-store';
import { distributeStore, distributionValid } from './distribute-store';

export function CornerCluster() {
  const prompt = useStore(appStores.prompt);
  const over = useStore(appStores.game, s => s.over !== undefined);
  const draft = useStore(amountStore, s => s.draft);
  const dDraft = useStore(distributeStore, s => s.draft);
  if (over) return null;

  const p = prompt.pending;
  const controls = promptControls(prompt);
  const busy = prompt.inflight && p !== undefined;

  const fire = (c: ControlSpec) => {
    if (p !== undefined && c.enabled) void appActions.answerPrompt(p.promptId, c.answer);
  };

  // chooseAmount: the OK's value comes from the screen-space selector's draft.
  const amountOk = p?.kind === 'chooseAmount'
    && draft?.promptId === p.promptId
    && draft.value >= p.min && draft.value <= p.max;

  // distribute (§5.5): Submit sends the chip panel's whole draft.
  const distOk = p?.kind === 'distribute'
    && dDraft?.promptId === p.promptId
    && distributionValid(p, dDraft.amounts);

  return (
    <div className={`corner-cluster${busy ? ' dock-busy' : ''}`}>
      {controls.special !== undefined && (
        <button data-answer="special" disabled={!controls.special.enabled}
          onClick={() => fire(controls.special!)}>
          {controls.special.label} <kbd>A</kbd>
        </button>
      )}
      {controls.secondary !== undefined && (
        <button data-answer="secondary" disabled={!controls.secondary.enabled}
          onClick={() => fire(controls.secondary!)}>
          {controls.secondary.label}
        </button>
      )}
      {controls.primary !== undefined && (
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
      {p?.kind === 'distribute' && (
        <button className="primary" data-answer="submit" disabled={prompt.inflight || !distOk}
          onClick={() => {
            if (distOk) {
              void appActions.answerPrompt(p.promptId, {
                type: 'distribution',
                amounts: p.among.map((row, i) => ({ id: row.id, amount: dDraft.amounts[i] ?? 0 })),
              });
            }
          }}>
          Submit
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
