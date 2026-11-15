// Phone-sized chrome (mobile plan §M2). One media query, mirrored by the pure
// `isCompactViewport` the canvas layout uses (layout/screen.ts), so the DOM chrome
// and the felt flip to their compact forms at the same width/height.

import { useSyncExternalStore } from 'react';
import { COMPACT_MAX_H, COMPACT_MAX_W } from '../layout/screen';

export const COMPACT_QUERY = `(max-width: ${COMPACT_MAX_W}px), (max-height: ${COMPACT_MAX_H}px)`;

/** A touch-first device held upright — where the table shows its rotate hint. */
export const PORTRAIT_PHONE_QUERY = '(orientation: portrait) and (pointer: coarse) and (max-width: 700px)';

const media = (q: string): MediaQueryList | undefined =>
  typeof window === 'undefined' || window.matchMedia === undefined ? undefined : window.matchMedia(q);

export function matches(q: string): boolean {
  return media(q)?.matches === true;
}

export function isCompact(): boolean {
  return matches(COMPACT_QUERY);
}

/** A live media query — re-renders when the phone rotates or the window resizes
 *  across the breakpoint. */
export function useMedia(q: string): boolean {
  return useSyncExternalStore(
    cb => {
      const m = media(q);
      m?.addEventListener('change', cb);
      return () => m?.removeEventListener('change', cb);
    },
    () => matches(q),
    () => false,
  );
}

export function useCompact(): boolean {
  return useMedia(COMPACT_QUERY);
}
