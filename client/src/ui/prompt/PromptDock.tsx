// The prompt dock (§7): at most one pending prompt, rendered in one fixed
// surface above the hand; all board affordances derive from the same pending
// prompt (CardView/SeatPanel side). Answers capture the promptId they rendered
// with; `inflight` disables the dock until promptDone or a superseding prompt.
// All 11 kinds render here (C3); chooseAbility anchors to its source card when
// it is on the board, falling back to the dock list otherwise.

import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import { appActions, appStores } from '../../app';
import type { AnswerValue, Card, Prompt } from '../../protocol/protocol';
import { parseManaCost } from '../../state/mana';
import { me, unreachableCandidates } from '../../state/selectors';
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
              <button data-answer="special" disabled={busy}
                onClick={() => answer({ type: 'option', key: 'special' })}>
                {p.combat.special} <kbd>A</kbd>
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
      return <ChooseTargetsControls p={p} busy={busy} answer={answer} prompt={prompt} state={state} />;

    case 'payMana': {
      const pool = me(state)?.manaPool;
      const held = pool !== undefined ? POOL_ORDER.filter(c => pool[c] > 0) : [];
      return (
        <>
          <span className="dock-cost"><ManaSymbols symbols={parseManaCost(p.remaining)} /></span>
          {(p.sources ?? []).length > 0 && <span className="dock-hint">click a highlighted source</span>}
          {held.map(c => (
            <button key={c} className="pool-spend" data-mana={c} disabled={busy} title={`pay ${c} from pool`}
              onClick={() => answer({ type: 'mana', color: c })}>
              <ManaSymbols symbols={[c]} /> ×{pool![c]}
            </button>
          ))}
          {p.canCancel && (
            <button data-answer="cancel" disabled={busy} onClick={() => answer({ type: 'cancel' })}>Cancel</button>
          )}
        </>
      );
    }

    case 'chooseAbility':
      return <ChooseAbilityControls p={p} busy={busy} answer={answer} />;

    case 'chooseOption':
      return (
        <span className={p.options.length > 4 ? 'dock-list dock-list-col' : 'dock-list'}>
          {p.options.map(o => (
            <button key={o.key} data-option-key={o.key} disabled={busy}
              onClick={() => answer({ type: 'option', key: o.key })}>
              {o.text}
            </button>
          ))}
          {p.required === false && (
            <button data-answer="decline" disabled={busy} onClick={() => answer({ type: 'cancel' })}>Decline</button>
          )}
        </span>
      );

    case 'choosePile':
      return (
        <Modal title={p.message}>
          <div className="piles">
            {([0, 1] as const).map(i => (
              <div key={i} className="pile-col">
                <button className="primary" data-answer={`pile-${i}`} disabled={busy}
                  onClick={() => answer({ type: 'pile', index: i })}>
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
              <button key={o.key} data-option-key={o.key} disabled={busy}
                onClick={() => answer({ type: 'option', key: o.key })}>
                {o.text}
              </button>
            ))}
          </div>
        </Modal>
      );
  }
}

// ── chooseAbility (§7): popover anchored to the source card when it's on the
// board; dock-fallback when off-board (or the anchor isn't in the DOM yet) ────

function ChooseAbilityControls({ p, busy, answer }: {
  p: Extract<Prompt, { kind: 'chooseAbility' }>;
  busy: boolean;
  answer(a: AnswerValue): void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (p.sourceId === undefined) return;
    const el = document.querySelector(`.board [data-card-id="${CSS.escape(p.sourceId)}"]`);
    setAnchor(el?.getBoundingClientRect() ?? null);
  }, [p.promptId, p.sourceId]);

  const buttons = p.options.map(o => (
    <button key={o.id} data-option-id={o.id} disabled={busy}
      onClick={() => answer({ type: 'object', objectId: o.id })}>
      {o.text}
    </button>
  ));

  if (anchor === null) return <span className="dock-list dock-list-col">{buttons}</span>;
  return (
    <>
      <span className="dock-hint">choose for the highlighted card</span>
      {createPortal(
        <div
          className="ability-popover"
          style={{ left: anchor.left + anchor.width / 2, top: anchor.top }}
        >
          {buttons}
        </div>,
        document.body,
      )}
    </>
  );
}

// ── chooseTargets (§7): scratch accumulates, Submit sends the whole set ──────

function ChooseTargetsControls({ p, busy, answer, prompt, state }: {
  p: Extract<Prompt, { kind: 'chooseTargets' }>;
  busy: boolean;
  answer(a: AnswerValue): void;
  prompt: CtrlProps['prompt'];
  state: CtrlProps['state'];
}) {
  const k = prompt.selected.length;
  const range = p.min === p.max ? String(p.min) : `${p.min}–${p.max}`;
  const declinable = !p.required || p.min === 0;
  const oneClick = p.max === 1;

  // Candidates the board can't highlight — pile zones (graveyard/exile) and
  // ids outside this seat's view. Without this the dock said "click a
  // highlighted target" over an empty board: a real dead end, live-caught
  // 2026-07-19 on "Select a nonland card from ai_2 graveyard". The server
  // sends these without a `cards` array, so the modal-grid path (§7) misses
  // them and they have to be offered right here.
  const stranded = p.cards !== undefined ? [] : unreachableCandidates(state, p.candidates);

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
          <button className="primary" data-answer="submit" disabled={busy || k < p.min || k > p.max}
            onClick={() => answer({ type: 'objects', objectIds: prompt.selected })}>
            Submit {k} / {range}
          </button>
        )}
        {declinable && (
          <button data-answer="decline" disabled={busy} onClick={() => answer({ type: 'cancel' })}>Decline</button>
        )}
      </footer>
    </Modal>
  );

  return (
    <>
      {grid}
      {p.progress !== undefined && (
        <span className="dock-hint">{p.progress.chosen} of {p.progress.of} chosen</span>
      )}
      {stranded.length > 0 && (
        <span className="dock-list stranded-targets">
          {stranded.map(s => (
            <button
              key={s.id}
              className={prompt.selected.includes(s.id) ? 'stranded-target card-selected' : 'stranded-target'}
              data-card-id={s.id}
              disabled={busy}
              title={s.card === undefined ? undefined : s.card.types.join(' ')}
              onClick={() => {
                if (oneClick) answer({ type: 'object', objectId: s.id });
                else appActions.toggleTarget(p.promptId, s.id);
              }}
            >
              {s.label}
            </button>
          ))}
        </span>
      )}
      {oneClick
        ? stranded.length === 0 && <span className="dock-hint">click a highlighted target</span>
        : (
          <button className="primary" data-answer="submit" disabled={busy || k < p.min || k > p.max}
            onClick={() => answer({ type: 'objects', objectIds: prompt.selected })}>
            Submit {k} / {range}
          </button>
        )}
      {/* incremental flow (§8): once the server has ≥ min, confirm=true means done */}
      {p.progress !== undefined && p.progress.chosen >= p.min && (
        <button data-answer="done" disabled={busy} onClick={() => answer({ type: 'confirm', value: true })}>Done</button>
      )}
      {declinable && (
        <button data-answer="decline" disabled={busy} onClick={() => answer({ type: 'cancel' })}>Decline</button>
      )}
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
      <button className="primary" data-answer="ok" disabled={busy || !valid}
        onClick={() => answer({ type: 'number', value })}>
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
        <button className="primary" data-answer="submit" disabled={busy || !valid}
          onClick={() => answer({ type: 'distribution', amounts: p.among.map((row, i) => ({ id: row.id, amount: amounts[i] ?? 0 })) })}>
          Submit
        </button>
        {p.canCancel === true && (
          <button data-answer="cancel" disabled={busy} onClick={() => answer({ type: 'cancel' })}>Cancel</button>
        )}
      </footer>
    </Modal>
  );
}
