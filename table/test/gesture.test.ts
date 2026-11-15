import { describe, expect, it } from 'vitest';
import { classifyPress, isTouchPointer, LONG_PRESS_MS } from '../src/scene/gesture';

const base = { dx: 0, dy: 0, elapsedMs: 0, touch: true, scrollable: false, slop: 6 };

describe('classifyPress (mobile plan §2)', () => {
  it('is pending inside the slop before the long-press delay', () => {
    expect(classifyPress({ ...base, dx: 3, elapsedMs: LONG_PRESS_MS - 1 })).toBe('pending');
  });

  it('long-presses a still touch held past the delay', () => {
    expect(classifyPress({ ...base, dx: 2, dy: 2, elapsedMs: LONG_PRESS_MS })).toBe('longPress');
  });

  it('never long-presses a mouse — it has hover and the right button', () => {
    expect(classifyPress({ ...base, touch: false, elapsedMs: 5000 })).toBe('pending');
  });

  it('a sideways touch swipe on a scrollable row scrolls it', () => {
    expect(classifyPress({ ...base, scrollable: true, dx: -20, dy: 5 })).toBe('hScroll');
  });

  it('a mostly-vertical move on the hand is still the cast drag', () => {
    expect(classifyPress({ ...base, scrollable: true, dx: 5, dy: -20 })).toBe('drag');
  });

  it('a sideways move off a scrollable row drags', () => {
    expect(classifyPress({ ...base, dx: 30 })).toBe('drag');
  });

  it('a mouse never swipes the row — the wheel does that', () => {
    expect(classifyPress({ ...base, touch: false, scrollable: true, dx: 30 })).toBe('drag');
  });

  it('treats touch and pen as touch, mouse as mouse', () => {
    expect(isTouchPointer('touch')).toBe(true);
    expect(isTouchPointer('pen')).toBe(true);
    expect(isTouchPointer('mouse')).toBe(false);
    expect(isTouchPointer(undefined)).toBe(false);
  });
});
