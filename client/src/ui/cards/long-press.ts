// Touch long-press for the classic client's cards (mobile plan §M3). A phone has
// no hover and no right button, so holding a card is how it reads one (the hover
// preview) and reaches its card menu — the only home of mana-only abilities.
//
// The hook also swallows the click that follows the hold: lifting the finger
// fires one, and on a playable card that click would cast it.

import { useRef, type PointerEvent as ReactPointerEvent } from 'react';

export const LONG_PRESS_MS = 450;
const SLOP_PX = 8;

export interface LongPressHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  /** Call first thing in the element's click handler: true ⇒ this click is the
   *  tail of a long-press and must do nothing. */
  consumeClick: () => boolean;
}

export function useLongPress(onLongPress: (el: HTMLElement) => void): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const fired = useRef(false);

  const clear = (): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    start.current = undefined;
  };

  return {
    onPointerDown: e => {
      fired.current = false;
      if (e.pointerType === 'mouse') return;   // the mouse has hover + right-click
      const el = e.currentTarget;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        timer.current = undefined;
        fired.current = true;
        onLongPress(el);
      }, LONG_PRESS_MS);
    },
    onPointerMove: e => {
      const s = start.current;
      if (s !== undefined && Math.hypot(e.clientX - s.x, e.clientY - s.y) > SLOP_PX) clear();   // a scroll, not a hold
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    consumeClick: () => {
      const was = fired.current;
      fired.current = false;
      return was;
    },
  };
}
