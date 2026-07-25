// Turn controls (design §7): the persistent §9 game.action cluster by the dock.
// The skip toggle renders from me.skip — never from the click: the server
// clears skips on its own, and skip:'stack' on an empty stack is a server
// no-op; state is the only truth. Rollback hides entirely when the table
// doesn't allow it (any AI-filled game, design §16.2).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { appActions, appStores } from '../app';
import type { GameState } from '@night/core/protocol/protocol';

type SkipMode = NonNullable<GameState['me']['skip']>;

const SKIP_LABEL: Record<SkipMode, string> = {
  stack: 'until the stack resolves',
  endOfTurn: 'to end of turn',
  nextMain: 'to next main phase',
  myNextTurn: 'to my next turn',
  endStepBeforeMyTurn: 'to the end step before my turn',
};

const SKIP_ITEMS: { mode: SkipMode; label: string; hint?: string }[] = [
  { mode: 'stack', label: 'Resolve stack' },
  { mode: 'endOfTurn', label: 'End of turn', hint: 'F4' },
  { mode: 'nextMain', label: 'Next main phase' },
  { mode: 'myNextTurn', label: 'My next turn', hint: 'F6' },
  { mode: 'endStepBeforeMyTurn', label: 'End step before my turn' },
];

/** A button that opens a dropdown; closes on any outside click. */
function MenuButton({ label, className, menu, testId }: {
  label: ReactNode; className?: string; menu: ReactNode; testId: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <span className="menu-root" ref={rootRef} data-testid={testId}>
      <button className={className} onClick={() => setOpen(o => !o)}>{label} ▾</button>
      {open && <div className="menu-pop" onClick={() => setOpen(false)}>{menu}</div>}
    </span>
  );
}

export function TurnControls() {
  const state = useStore(appStores.game, s => s.state);
  const over = useStore(appStores.game, s => s.over !== undefined);
  const autoMana = useStore(appStores.game, s => s.autoMana);
  if (state === undefined || over) return null;

  const active = state.me.skip;
  const send = (p: Promise<void>) => void p.catch(e => console.warn('[action]', e));

  return (
    <span className="turn-controls">
      <MenuButton
        testId="skip-menu"
        className={active !== undefined ? 'skip-active' : undefined}
        label={active !== undefined ? `Skipping ${SKIP_LABEL[active]}` : 'Skip'}
        menu={
          <>
            {SKIP_ITEMS.map(item => (
              <button key={item.mode} data-skip={item.mode}
                className={active === item.mode ? 'menu-on' : undefined}
                onClick={() => send(appActions.setSkip(item.mode))}>
                {active === item.mode ? '✓ ' : ''}{item.label}
                {item.hint !== undefined && <kbd>{item.hint}</kbd>}
              </button>
            ))}
            {active !== undefined && (
              <button data-skip="cancel" onClick={() => send(appActions.setSkip('cancel'))}>
                Cancel skip
              </button>
            )}
          </>
        }
      />

      <label className="auto-mana" title="let the server pay costs from obvious sources (§9)">
        <input type="checkbox" checked={autoMana}
          onChange={() => send(appActions.setAutoMana(!autoMana))} />
        auto-mana
      </label>

      <MenuButton
        testId="table-menu"
        label="Table"
        menu={
          <>
            {state.rollbackTurnsAllowed && (
              <>
                <button data-table="rollback-0" onClick={() => send(appActions.requestRollback(0))}>
                  Rollback: restart this turn
                </button>
                <button data-table="rollback-1" onClick={() => send(appActions.requestRollback(1))}>
                  Rollback: to previous turn
                </button>
              </>
            )}
            <button data-table="trigger-reset" onClick={() => send(appActions.resetTriggerOrder())}>
              Reset trigger ordering
            </button>
          </>
        }
      />

      <ConcedeControl />
    </span>
  );
}

/** Concede is irreversible → type-to-confirm (§7), in a corner pop-panel
 *  (prompts-on-the-table §5: zero backdrop-modals). Closes on outside click,
 *  like the menus; no Escape handling, so it can never race the document
 *  shortcut listener for a pending prompt — while typing, `isTextInput`
 *  suspends shortcuts anyway. */
function ConcedeControl() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <span className="menu-root" ref={rootRef}>
      <button className="concede-btn" onClick={() => { setText(''); setOpen(o => !o); }}>Concede</button>
      {open && (
        <div className="menu-pop concede-pop">
          <p className="modal-msg">This cannot be undone. Type <b>concede</b> to confirm.</p>
          <input
            autoFocus
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="concede"
          />
          <div className="concede-actions">
            <button
              className="danger"
              disabled={text.trim().toLowerCase() !== 'concede'}
              onClick={() => {
                setOpen(false);
                void appActions.concede().catch(() => { /* surfaced via log/status */ });
              }}
            >
              Concede
            </button>
            <button onClick={() => setOpen(false)}>Keep playing</button>
          </div>
        </div>
      )}
    </span>
  );
}
