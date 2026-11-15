// The inspect sheet (mobile plan §3): one card, big, with the buttons that act on
// it. It is how a phone reads and casts — a touch tap on a playable hand card
// opens it with an explicit **Cast**, so casting stays two deliberate steps
// (Issues.txt #10) without needing the drag a finger does badly — and it is the
// mana-ability menu the canvas never had (long-press on touch, right-click on
// desktop). Every button answers through the same router a felt click uses.

import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { appScryfall, appStores } from '../app';
import { affordanceFor, findObject } from '@night/core/state/selectors';
import { answerObject, objectClick } from './interact';
import { closeInspect, inspectStore } from './inspect-store';
import { inspectButtons, type InspectButton } from './inspect-actions';
import { TextFrame } from './CardView';
import { ManaText } from './ManaSymbols';

export function InspectSheet() {
  const id = useStore(inspectStore, s => s.id);
  const snapshot = useStore(inspectStore, s => s.card);
  const state = useStore(appStores.game, s => s.state);
  const prompt = useStore(appStores.prompt);
  const live = id !== undefined && state !== undefined ? findObject(state, id) : undefined;
  const card = live ?? snapshot;
  const image = useStore(appScryfall.store, s => (card !== undefined ? s.images[appScryfall.keyOf(card)] : undefined));
  // The sheet opens under a finger that is often still down (a long-press), or
  // whose tap has not finished dispatching — and lifting it fires a click on
  // whatever is now beneath: the backdrop, or a button that happened to land
  // there (a hand card's sheet puts Close right under the thumb). So nothing in
  // the sheet acts on a click until the sheet has seen a press of its own, and the
  // backdrop only dismisses a press that *began* on it.
  const armed = useRef(false);
  const downOnBackdrop = useRef(false);
  useEffect(() => { armed.current = false; }, [id]);

  // Esc closes (the window-level shortcut handler skips Esc while a dialog is up).
  useEffect(() => {
    if (id === undefined) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); closeInspect(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [id]);

  if (id === undefined || card === undefined) return null;

  const aff = affordanceFor(prompt, id);
  const buttons = inspectButtons(aff, prompt.inflight);
  const actionTexts = aff?.kind === 'action' || aff?.kind === 'manaOnly'
    ? aff.actions.map(a => a.text).filter(t => t.length > 0) : [];

  const press = (b: InspectButton): void => {
    const p = prompt.pending;
    if (p === undefined) return;
    if (b.verb === 'mana') answerObject(p.promptId, id);
    else objectClick(prompt, id);
    closeInspect();
  };

  return (
    <div className="inspect-backdrop" data-testid="inspect-sheet"
      onPointerDownCapture={e => { armed.current = true; downOnBackdrop.current = e.target === e.currentTarget; }}
      onClickCapture={e => { if (!armed.current) { e.stopPropagation(); e.preventDefault(); } }}
      onClick={e => { if (downOnBackdrop.current && e.target === e.currentTarget) closeInspect(); }}>
      <div className="inspect-sheet" role="dialog" aria-label={card.name} onClick={e => e.stopPropagation()}>
        <div className="inspect-card">
          {image?.status === 'ok'
            ? <img src={image.url} alt={card.name} draggable={false} />
            : <TextFrame card={card} size="preview" />}
        </div>
        <div className="inspect-side">
          <div className="inspect-name">{card.name}</div>
          {card.text.length > 0 && (
            <div className="inspect-oracle">
              {card.text.map((l, i) => <p key={i}><ManaText text={l} /></p>)}
            </div>
          )}
          {actionTexts.length > 1 && (
            <ul className="inspect-abilities">
              {actionTexts.map((t, i) => <li key={i}><ManaText text={t} /></li>)}
            </ul>
          )}
          <div className="inspect-buttons">
            {buttons.map(b => (
              <button key={b.label} className={b.primary ? 'primary' : undefined}
                data-inspect={b.verb} onClick={() => press(b)}>{b.label}</button>
            ))}
            <button className="inspect-close" onClick={closeInspect}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}
