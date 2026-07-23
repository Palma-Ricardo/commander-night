// Keyboard wiring (design §7, §7.3). Two layers on one document listener,
// suspended while a text input (chat) has focus:
//
//  • Game shortcuts — the shared pure resolver (state/shortcuts.ts): Space pass,
//    Enter primary, F4/F6 skips, A all-attack, Esc decline a declinable prompt.
//  • Camera — table-client-only: 1–4 pin a seat, ` (or 0) frames the whole table,
//    Esc releases the manual pin back to following the active player.
//
// Esc is claimed by both. Resolution: a *declinable* pending prompt wins (declining
// is the rarer, more consequential intent and the game shortcut already fences it
// on promptId); otherwise Esc releases the camera. Digits and backtick are never
// game shortcuts, so they always mean the camera.

import { useEffect } from 'react';
import { appActions, appStores } from '../app';
import { resolveShortcut } from '@night/core/state/shortcuts';
import { getActiveScene } from '../scene/TableScene';

export function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT' || target.isContentEditable;
}

/** Mounted by the game overlay — shortcuts exist only where a game does. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // e.repeat: a held key must not answer prompts that arrive mid-hold — each
      // repeat would capture the NEW promptId, defeating the §7 fencing.
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTextInput(e.target)) return;
      // A pile browser or a confirmation dialog (Modal suspendsShortcuts) owns the
      // keyboard while open — this listener sits on `document`, which fires BEFORE
      // that modal's own `window` Escape handler (bubble order: target → document
      // → window), so without this guard Escape-to-close-the-popup would also
      // cancel whatever prompt is pending underneath it.
      if (document.querySelector('.modal-suspends-shortcuts') !== null) return;

      const game = appStores.game.getState();
      if (game.state === undefined) return;
      const scene = getActiveScene();

      // Camera keys first — never game shortcuts, so they cannot steal a prompt.
      if (e.key >= '1' && e.key <= '4') { e.preventDefault(); scene?.focusSeat(Number(e.key) - 1); return; }
      if (e.key === '`' || e.key === '0') { e.preventDefault(); scene?.showTable(); return; }

      const eff = resolveShortcut(e.key, appStores.prompt.getState(), game.over !== undefined);
      if (eff !== undefined) {
        e.preventDefault();
        if (eff.do === 'answer') void appActions.answerPrompt(eff.promptId, eff.answer);
        else void appActions.sendGameAction(eff.action).catch(err => console.warn('[action]', err));
        return;
      }

      // Esc with nothing to decline releases the manual camera pin.
      if (e.key === 'Escape') { e.preventDefault(); scene?.releaseCamera(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
