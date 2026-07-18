// The prompt dock (§7): at most one pending prompt, rendered in one fixed
// surface above the hand; all board affordances derive from the same pending
// prompt (CardView/SeatPanel side). Answers capture the promptId they rendered
// with; `inflight` disables the dock until promptDone or a superseding prompt.
//
// C2 ships the four kinds a real game needs (confirm/priority/chooseTargets/
// payMana) with full board affordances, plus functional dock surfaces for the
// remaining kinds so no known prompt can dead-end a live game; C3 polishes
// those (combat badges/pulse UX, chooseAbility popover anchoring, shortcuts).

import { useState } from 'react';
import { useStore } from 'zustand';
import { appActions, appStores } from '../../app';
import type { AnswerValue, Card, Prompt } from '../../protocol/protocol';
import { parseManaCost } from '../../state/mana';
import { me } from '../../state/selectors';
import { CardGrid, Modal } from '../board/Modal';
import { ManaSymbols } from '../cards/ManaSymbols';

const POOL_ORDER = ['W', 'U', 'B', 'R', 'G', 'C'] as const;

export function PromptDock() {
  const prompt = useStore(appStores.prompt);
  const state = useStore(appStores.game, s => s.state);
  const p = prompt.pending;
  if (p === undefined || state === undefined) return null;

  const pid = p.promptId;
  const busy = prompt.inflight;
  const answer = (a: AnswerValue) => void appActions.answerPrompt(pid, a);

  return (
    <div className={`prompt-dock dock-${p.kind}${busy ? ' dock-busy' : ''}`} data-prompt-kind={p.kind}>
      <span className="dock-msg">{p.message}</span>
      <span className="dock-controls">
        <DockControls key={pid} p={p} busy={busy} answer={answer} prompt={prompt} state={state} />
      </span>
      {busy && <span className="badge-spinner dock-spinner" aria-label="waiting for server" />}
    </div>
  );
}

interface CtrlProps {
  p: Prompt;
  busy: boolean;
  answer(a: AnswerValue): void;
  prompt: ReturnType<typeof appStores.prompt.getState>;
  state: NonNullable<ReturnType<typeof appStores.game.getState>['state']>;
}

function DockControls({ p, busy, answer, prompt, state }: CtrlProps) {
  switch (p.kind) {
    case 'confirm':
      return (
        <>
          <button className="primary" data-answer="yes" disabled={busy}
            onClick={() => answer({ type: 'confirm', value: true })}>
            {p.yesText ?? 'Yes'}
          </button>
          <button data-answer="no" disabled={busy} onClick={() => answer({ type: 'confirm', value: false })}>
            {p.noText ?? 'No'}
          </button>
        </>
      );

    case 'priority': {
      if (p.combat !== undefined) {
        // C2: toggles happen on the board (one round trip each, §8); the dock
        // carries Done + the special shortcut. Full combat UX polish is C3.
        return (
          <>
            <span className="dock-hint">
              {p.combat.candidates.length > 0
                ? `click creatures to ${p.combat.role === 'attackers' ? 'attack' : 'block'}`
                : 'nothing can be declared'}
            </span>
            {p.combat.special !== undefined && (
              <button disabled={busy} onClick={() => answer({ type: 'option', key: 'special' })}>
                {p.combat.special}
              </button>
            )}
            <button className="primary" data-answer="done" disabled={busy}
              onClick={() => answer({ type: 'confirm', value: true })}>
              Done
            </button>
          </>
        );
      }
      const anyAction = Object.values(p.playable)
        .some(actions => actions.some(a => a.kind !== 'mana'));
      return (
        <>
          {anyAction && <span className="dock-hint">click a highlighted card to act</span>}
          <button
            className={anyAction ? '' : 'primary'}
            data-answer="pass"
            disabled={busy}
            onClick={() => answer({ type: 'confirm', value: false })}
          >
            Pass
          </button>
        </>
      );
    }

    case 'chooseTargets':
      return <ChooseTargetsControls p={p} busy={busy} answer={answer} prompt={prompt} />;

    case 'payMana': {
      const pool = me(state)?.manaPool;
      const held = pool !== undefined ? POOL_ORDER.filter(c => pool[c] > 0) : [];
      return (
        <>
          <span className="dock-cost"><ManaSymbols symbols={parseManaCost(p.remaining)} /></span>
          {(p.sources ?? []).length > 0 && <span className="dock-hint">click a highlighted source</span>}
          {held.map(c => (
            <button key={c} className="pool-spend" disabled={busy} title={`pay ${c} from pool`}
              onClick={() => answer({ type: 'mana', color: c })}>
              <ManaSymbols symbols={[c]} /> ×{pool![c]}
            </button>
          ))}
          {p.canCancel && (
            <button disabled={busy} onClick={() => answer({ type: 'cancel' })}>Cancel</button>
          )}
        </>
      );
    }

    case 'chooseAbility':
      return (
        <span className="dock-list">
          {p.options.map(o => (
            <button key={o.id} disabled={busy} onClick={() => answer({ type: 'object', objectId: o.id })}>
              {o.text}
            </button>
          ))}
        </span>
      );

    case 'chooseOption':
      return (
        <span className={p.options.length > 4 ? 'dock-list dock-list-col' : 'dock-list'}>
          {p.options.map(o => (
            <button key={o.key} disabled={busy} onClick={() => answer({ type: 'option', key: o.key })}>
              {o.text}
            </button>
          ))}
          {p.required === false && (
            <button disabled={busy} onClick={() => answer({ type: 'cancel' })}>Decline</button>
          )}
        </span>
      );

    case 'choosePile':
      return (
        <Modal title={p.message}>
          <div className="piles">
            {([0, 1] as const).map(i => (
              <div key={i} className="pile-col">
                <button className="primary" disabled={busy} onClick={() => answer({ type: 'pile', index: i })}>
                  Choose pile {i + 1}
                </button>
                <CardGrid cards={p.piles[i]} />
              </div>
            ))}
          </div>
        </Modal>
      );

    case 'chooseAmount':
      return <AmountControls min={p.min} max={p.max} busy={busy} answer={answer} />;

    case 'distribute':
      return <DistributeControls p={p} busy={busy} answer={answer} />;

    case 'playerRequest':
      return (
        <Modal title={p.requestKey}>
          <p className="modal-msg">{p.message}</p>
          <div className="dock-list">
            {p.options.map(o => (
              <button key={o.key} disabled={busy} onClick={() => answer({ type: 'option', key: o.key })}>
                {o.text}
              </button>
            ))}
          </div>
        </Modal>
      );
  }
}

// ── chooseTargets (§7): scratch accumulates, Submit sends the whole set ──────

function ChooseTargetsControls({ p, busy, answer, prompt }: {
  p: Extract<Prompt, { kind: 'chooseTargets' }>;
  busy: boolean;
  answer(a: AnswerValue): void;
  prompt: CtrlProps['prompt'];
}) {
  const k = prompt.selected.length;
  const range = p.min === p.max ? String(p.min) : `${p.min}–${p.max}`;
  const declinable = !p.required || p.min === 0;
  const oneClick = p.max === 1;

  const grid = p.cards !== undefined && p.cards.length > 0 && (
    <Modal title={p.message}>
      <CardGrid
        cards={p.cards}
        selectedIds={prompt.selected}
        onCardClick={(c: Card) => {
          if (busy) return;
          if (oneClick) answer({ type: 'object', objectId: c.id });
          else appActions.toggleTarget(p.promptId, c.id);
        }}
      />
      <footer className="modal-actions">
        {!oneClick && (
          <button className="primary" disabled={busy || k < p.min || k > p.max}
            onClick={() => answer({ type: 'objects', objectIds: prompt.selected })}>
            Submit {k} / {range}
          </button>
        )}
        {declinable && <button disabled={busy} onClick={() => answer({ type: 'cancel' })}>Decline</button>}
      </footer>
    </Modal>
  );

  return (
    <>
      {grid}
      {p.progress !== undefined && (
        <span className="dock-hint">{p.progress.chosen} of {p.progress.of} chosen</span>
      )}
      {oneClick
        ? <span className="dock-hint">click a highlighted target</span>
        : (
          <button className="primary" disabled={busy || k < p.min || k > p.max}
            onClick={() => answer({ type: 'objects', objectIds: prompt.selected })}>
            Submit {k} / {range}
          </button>
        )}
      {/* incremental flow (§8): once the server has ≥ min, confirm=true means done */}
      {p.progress !== undefined && p.progress.chosen >= p.min && (
        <button disabled={busy} onClick={() => answer({ type: 'confirm', value: true })}>Done</button>
      )}
      {declinable && <button disabled={busy} onClick={() => answer({ type: 'cancel' })}>Decline</button>}
    </>
  );
}

// ── chooseAmount (§7): stepper clamped to min(max,99), free input to max ─────

function AmountControls({ min, max, busy, answer }: {
  min: number; max: number; busy: boolean; answer(a: AnswerValue): void;
}) {
  const [value, setValue] = useState(min);
  const stepMax = Math.min(max, 99);
  const valid = value >= min && value <= max;
  return (
    <>
      <button disabled={busy || value <= min} onClick={() => setValue(v => v - 1)}>−</button>
      <input
        className="amount-input"
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={e => setValue(Number(e.target.value))}
      />
      <button disabled={busy || value >= stepMax} onClick={() => setValue(v => v + 1)}>+</button>
      {/* no cancel control — the answer is required (§8) */}
      <button className="primary" disabled={busy || !valid} onClick={() => answer({ type: 'number', value })}>
        OK
      </button>
    </>
  );
}

// ── distribute (§8): built from spec + fixtures, never observed live ─────────

function DistributeControls({ p, busy, answer }: {
  p: Extract<Prompt, { kind: 'distribute' }>; busy: boolean; answer(a: AnswerValue): void;
}) {
  const [amounts, setAmounts] = useState<number[]>(() =>
    p.among.map(row => row.suggested ?? row.min ?? 0));
  const sum = amounts.reduce((a, b) => a + b, 0);
  const rowsValid = p.among.every((row, i) => {
    const v = amounts[i] ?? 0;
    return (row.min === undefined || v >= row.min) && (row.max === undefined || v <= row.max) && v >= 0;
  });
  const valid = rowsValid && sum >= p.min && sum <= p.total;
  return (
    <Modal title={p.message}>
      <div className="distribute-rows">
        {p.among.map((row, i) => (
          <label key={row.id} className="distribute-row">
            <span>{row.label}</span>
            <input
              type="number"
              value={amounts[i] ?? 0}
              min={row.min ?? 0}
              max={row.max ?? p.total}
              onChange={e => {
                const v = Number(e.target.value);
                setAmounts(a => a.map((x, j) => (j === i ? v : x)));
              }}
            />
          </label>
        ))}
      </div>
      <p className={valid ? 'muted' : 'error'}>total {sum} (need {p.min === p.total ? p.total : `${p.min}–${p.total}`})</p>
      <footer className="modal-actions">
        <button className="primary" disabled={busy || !valid}
          onClick={() => answer({ type: 'distribution', amounts: p.among.map((row, i) => ({ id: row.id, amount: amounts[i] ?? 0 })) })}>
          Submit
        </button>
        {p.canCancel === true && <button disabled={busy} onClick={() => answer({ type: 'cancel' })}>Cancel</button>}
      </footer>
    </Modal>
  );
}
