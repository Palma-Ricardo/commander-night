// The prompt dock (§7), mid-strangulation (prompts-on-the-table §2): the
// not-yet-migrated prompt kinds render their non-board controls here, in one
// fixed surface by the corner. The message moved to InstructionLine, and
// confirm / priority / chooseAmount moved to the corner cluster + amount
// selector at T7 — this file shrinks kind-by-kind until T9 deletes it.
// Board highlighting and hit-testing live on the canvas (TableScene); answers
// capture the promptId they rendered with; `inflight` disables the dock until
// promptDone or a superseding prompt. Ported and adapted from
// client/src/ui/prompt/PromptDock.tsx.
//
// One deliberate divergence from the classic dock: chooseAbility does not anchor
// a popover to the source card. The classic client found it with a `.board
// [data-card-id]` query; on the canvas the source is a Pixi actor (highlighted by
// the scene), so the options render as a dock list and the hint points at the
// highlighted card. Every ability is still one click away.

import { useState } from 'react';
import { useStore } from 'zustand';
import { appActions, appStores } from '../app';
import type { AnswerValue, Card, Prompt } from '@night/core/protocol/protocol';
import { parseManaCost } from '@night/core/state/mana';
import { me, unreachableCandidates } from '@night/core/state/selectors';
import { CardGrid, Modal } from './Modal';
import { ManaSymbols } from './ManaSymbols';
import { dockOwns } from './migration';

const POOL_ORDER = ['W', 'U', 'B', 'R', 'G', 'C'] as const;

export function PromptDock() {
  const prompt = useStore(appStores.prompt);
  const state = useStore(appStores.game, s => s.state);
  const p = prompt.pending;
  // Migrated kinds render on the canvas + corner cluster (migration.ts); the
  // dock shrinks kind-by-kind until T9 deletes it.
  if (p === undefined || state === undefined || !dockOwns(p, state)) return null;

  const pid = p.promptId;
  const busy = prompt.inflight;
  const answer = (a: AnswerValue) => void appActions.answerPrompt(pid, a);

  return (
    <div className={`prompt-dock dock-${p.kind}${busy ? ' dock-busy' : ''}`} data-prompt-kind={p.kind}>
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

// ── chooseAbility (§7): dock list, with a hint pointing at the canvas-highlighted
// source card when the server names one ────────────────────────────────────────

function ChooseAbilityControls({ p, busy, answer }: {
  p: Extract<Prompt, { kind: 'chooseAbility' }>;
  busy: boolean;
  answer(a: AnswerValue): void;
}) {
  return (
    <>
      {p.sourceId !== undefined && <span className="dock-hint">choose for the highlighted card</span>}
      <span className="dock-list dock-list-col">
        {p.options.map(o => (
          <button key={o.id} data-option-id={o.id} disabled={busy}
            onClick={() => answer({ type: 'object', objectId: o.id })}>
            {o.text}
          </button>
        ))}
      </span>
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

  // Candidates the canvas can't offer as a click — pile zones (graveyard/exile,
  // stacked so only the top card is hit-testable) and ids outside this seat's
  // view. Without this the dock said "click a highlighted target" over a board
  // with nothing clickable: a real dead end (§13's no-dead-end invariant,
  // live-caught 2026-07-19 on "Select a nonland card from <opponent> graveyard").
  // The server sends these without a `cards` array, so the modal-grid path misses
  // them and they have to be offered right here.
  const stranded = p.cards !== undefined ? [] : unreachableCandidates(state, p.candidates);

  // When the server sends the candidates as `cards` they are usually *not* on the
  // felt at all (a library look, an opponent's graveyard), so the modal grid is the
  // whole affordance and the "click a highlighted target" hint below is a lie —
  // there is nothing highlighted to click. Live-caught 2026-07-24 on Mosswort
  // Bridge's Hideaway ("Select a card to exile face down").
  const hasGrid = p.cards !== undefined && p.cards.length > 0;

  const grid = hasGrid && (
    <Modal title={p.message}>
      <CardGrid
        cards={p.cards ?? []}
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
            Submit {k} of {range}
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
      {/* The server's progress echoes the message and the Submit counter, so only
          surface it once it carries something they don't — a running server-side
          tally in an incremental pick (§8). At rest (a batch discard: chosen 0)
          it stayed on screen three times over ("0 of 8" everywhere). */}
      {p.progress !== undefined && p.progress.chosen > 0 && p.progress.chosen !== k && (
        <span className="dock-hint">{p.progress.chosen} confirmed by the server</span>
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
      {/* A felt/hand-reachable chooseTargets never reaches the dock since T8
          (migration.ts) — no "click a highlighted target" hint to render. */}
      {!oneClick && (
        <button className="primary" data-answer="submit" disabled={busy || k < p.min || k > p.max}
          onClick={() => answer({ type: 'objects', objectIds: prompt.selected })}>
          Submit {k} of {range}
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
