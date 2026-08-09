// Keyboard wiring (design §7, §7.3). Three layers on one document listener,
// suspended while a text input (chat, the carousel filter, concede) has focus
// — since T9 deleted the modals, focus is the *only* suspension (§8).
//
//  • Carousel / hand seek — ArrowLeft/Right push the open carousel strip by one
//    card, else the hand fan (#8: both scroll continuously, neither pages); Esc
//    closes an open *browse* fan (a prompt-mode fan is the prompt UI and lives
//    exactly as long as its ask).
//  • Game shortcuts — the shared pure resolver (state/shortcuts.ts): Space pass,
//    Enter primary, F4/F6 skips, A all-attack, Esc decline a declinable prompt.
//  • Camera — table-client-only: 1–4 pin a seat, ` (or 0) frames the whole table,
//    Esc releases the manual pin back to following the active player.
//
// Esc precedence: an open browse fan (the thing visually on top) → a declinable
// pending prompt (declining is the more consequential intent, and the game
// shortcut already fences it on promptId) → the camera pin. Digits, backtick
// and arrows are never game shortcuts, so they can't steal a prompt.

import { useEffect } from 'react';
import { appActions, appStores } from '../app';
import { resolveShortcut } from '@night/core/state/shortcuts';
import { getActiveScene } from '../scene/TableScene';
import { carouselContent } from '../layout/carousel';
import { carouselStore, closeBrowse } from '../scene/carousel-store';

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

      const game = appStores.game.getState();
      if (game.state === undefined) return;
      const scene = getActiveScene();

      // Camera keys first — never game shortcuts, so they cannot steal a prompt.
      if (e.key >= '1' && e.key <= '4') { e.preventDefault(); scene?.focusSeat(Number(e.key) - 1); return; }
      if (e.key === '`' || e.key === '0') { e.preventDefault(); scene?.showTable(); return; }

      // Seeking (§4.4): arrows push the open carousel's strip by one card, else the
      // hand fan (#8 — both scroll now; the scene owns the clamp, since only it
      // knows the viewport). A hand that fits swallows nothing.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        const ui = carouselStore.getState();
        const content = carouselContent(
          appStores.prompt.getState(), game.state, ui.browse, ui.filter, ui.viewKey);
        if (content !== undefined) {
          e.preventDefault();
          scene?.scrollCarouselBy(delta);
          return;
        }
        if (scene?.scrollHandBy(delta) === true) e.preventDefault();
        return;
      }

      // Esc closes an open browse fan before anything else — it is the surface
      // visually on top. (Prompt mode has no close; the ask owns it.)
      if (e.key === 'Escape') {
        const ui = carouselStore.getState();
        const content = carouselContent(appStores.prompt.getState(), game.state, ui.browse, ui.filter);
        if (content?.mode === 'browse') { e.preventDefault(); closeBrowse(); return; }
      }

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
