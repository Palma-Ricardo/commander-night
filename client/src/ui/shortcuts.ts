// Keyboard shortcut wiring (design §7): document keydown → the pure resolver
// (state/shortcuts.ts) → answer/action dispatch. Suspended while any text
// input has focus.

import { useEffect } from 'react';
import { appActions, appStores } from '../app';
import { resolveShortcut } from '@night/core/state/shortcuts';

export function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT' || target.isContentEditable;
}

/** Mounted by the Game screen — shortcuts exist only where a game does. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // e.repeat: a held key must not answer prompts that arrive mid-hold —
      // each repeat would capture the NEW promptId, defeating the §7 fencing
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTextInput(e.target)) return;
      // A pile browser or a confirmation dialog (Modal suspendsShortcuts) owns
      // the keyboard while it's open — this listener sits on `document`, which
      // fires BEFORE that modal's own `window` Escape handler (bubble order:
      // target → document → window), so without this guard Escape-to-close-the-
      // popup would also cancel whatever prompt is pending underneath it.
      if (document.querySelector('.modal-suspends-shortcuts') !== null) return;
      const game = appStores.game.getState();
      if (game.state === undefined) return;
      const eff = resolveShortcut(e.key, appStores.prompt.getState(), game.over !== undefined);
      if (eff === undefined) return;
      e.preventDefault();
      if (eff.do === 'answer') void appActions.answerPrompt(eff.promptId, eff.answer);
      else void appActions.sendGameAction(eff.action).catch(err => console.warn('[action]', err));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
