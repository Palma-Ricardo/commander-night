// Touch gesture classification (mobile plan, docs/plans/2026-11-14-mobile.md §2).
// Pixi-free like interaction.ts, so the rules are unit-tested headlessly; the
// scene feeds it the live press and acts on the verdict.
//
// A press on a card is one of four things, decided by how far and which way the
// pointer has travelled and for how long:
//
//  • pending   — still inside the slop and not yet held long enough: undecided.
//                Released here it is an ordinary tap.
//  • longPress — held inside the slop for LONG_PRESS_MS: "let me read this". The
//                scene opens the inspect sheet and swallows the tap that follows.
//  • hScroll   — a touch press that left the slop mostly sideways on a scrollable
//                row (the hand fan, the carousel strip): the finger pushes the row.
//  • drag      — left the slop any other way: the existing cast lift / point drag.
//
// The mouse never long-presses or swipes — it has hover, the wheel and the right
// button for those — so a mouse press is only ever pending or drag, exactly as
// before this file existed.

export const LONG_PRESS_MS = 450;

export type PressVerdict = 'pending' | 'longPress' | 'hScroll' | 'drag';

export interface PressInput {
  dx: number;
  dy: number;
  elapsedMs: number;
  /** pointerType !== 'mouse' — touch and pen get the touch gestures. */
  touch: boolean;
  /** The press began on a row that scrolls sideways (hand fan / carousel strip). */
  scrollable: boolean;
  slop: number;
}

export function classifyPress(p: PressInput): PressVerdict {
  const dist = Math.hypot(p.dx, p.dy);
  if (dist < p.slop) {
    return p.touch && p.elapsedMs >= LONG_PRESS_MS ? 'longPress' : 'pending';
  }
  if (p.touch && p.scrollable && Math.abs(p.dx) > Math.abs(p.dy)) return 'hScroll';
  return 'drag';
}

/** Whether a pointer type gets the touch gestures. Pen behaves like a finger here:
 *  it has no hover-without-contact on most phones and no right button. */
export function isTouchPointer(pointerType: string | undefined): boolean {
  return pointerType !== undefined && pointerType !== 'mouse';
}
