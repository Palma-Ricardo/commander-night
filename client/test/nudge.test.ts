// Background-tab priority nudge (C5). document is injected because a real
// backgrounded tab is not drivable from Playwright — this is the whole test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NUDGE_TITLE, startNudge, type NudgeDoc } from '../src/ui/nudge';
import { createPromptStore } from '@night/core/stores/prompt';
import type { Prompt } from '@night/core/protocol/protocol';

const priority = (promptId: number): Prompt =>
  ({ kind: 'priority', promptId, actions: [] } as unknown as Prompt);
const confirm = (promptId: number): Prompt =>
  ({ kind: 'confirm', promptId, message: 'ok?' } as unknown as Prompt);

function fakeDoc(): NudgeDoc & { fire(): void } {
  const listeners: (() => void)[] = [];
  return {
    hidden: false,
    title: 'Commander Night',
    addEventListener(_t, fn) { listeners.push(fn); },
    removeEventListener(_t, fn) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    fire() { for (const fn of [...listeners]) fn(); },
  };
}

let doc: ReturnType<typeof fakeDoc>;
let prompt: ReturnType<typeof createPromptStore>;
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  doc = fakeDoc();
  prompt = createPromptStore();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

describe('startNudge', () => {
  it('does not flash while the tab is visible', () => {
    stop = startNudge({ doc, prompt });
    prompt.setState({ pending: priority(1) });
    vi.advanceTimersByTime(5000);
    expect(doc.title).toBe('Commander Night');
  });

  it('flashes when a priority prompt arrives while hidden', () => {
    doc.hidden = true;
    stop = startNudge({ doc, prompt });
    prompt.setState({ pending: priority(1) });
    vi.advanceTimersByTime(1200);
    expect(doc.title).toBe(NUDGE_TITLE);
    vi.advanceTimersByTime(1200);
    expect(doc.title).toBe('Commander Night');
  });

  it('does not flash for non-priority prompts', () => {
    doc.hidden = true;
    stop = startNudge({ doc, prompt });
    prompt.setState({ pending: confirm(1) });
    vi.advanceTimersByTime(5000);
    expect(doc.title).toBe('Commander Night');
  });

  it('restores the title when the tab is foregrounded', () => {
    doc.hidden = true;
    stop = startNudge({ doc, prompt });
    prompt.setState({ pending: priority(1) });
    vi.advanceTimersByTime(1200);
    expect(doc.title).toBe(NUDGE_TITLE);

    doc.hidden = false;
    doc.fire();
    expect(doc.title).toBe('Commander Night');
    vi.advanceTimersByTime(5000);
    expect(doc.title).toBe('Commander Night');
  });

  it('restores the title when the prompt resolves', () => {
    doc.hidden = true;
    stop = startNudge({ doc, prompt });
    prompt.setState({ pending: priority(1) });
    vi.advanceTimersByTime(1200);
    expect(doc.title).toBe(NUDGE_TITLE);

    prompt.setState({ pending: undefined });
    expect(doc.title).toBe('Commander Night');
  });

  it('restores the title and detaches on dispose', () => {
    doc.hidden = true;
    const dispose = startNudge({ doc, prompt });
    prompt.setState({ pending: priority(1) });
    vi.advanceTimersByTime(1200);
    expect(doc.title).toBe(NUDGE_TITLE);

    dispose();
    expect(doc.title).toBe('Commander Night');
    vi.advanceTimersByTime(5000);
    expect(doc.title).toBe('Commander Night');
  });

  it('is idempotent when store updates while flashing', () => {
    doc.hidden = true;
    stop = startNudge({ doc, prompt });
    prompt.setState({ pending: priority(1) });

    // First flash cycle: advance 1200ms
    vi.advanceTimersByTime(1200);
    expect(doc.title).toBe(NUDGE_TITLE);
    expect(vi.getTimerCount()).toBe(1);

    // Update with a different priority prompt while flashing
    prompt.setState({ pending: priority(2) });

    // Assert: still only one interval (start() guard prevents re-registration)
    expect(vi.getTimerCount()).toBe(1);

    // Second flash cycle: advance 1200ms
    // If the guard worked, this flips to baseTitle on the original interval
    // If guard failed, duplicate intervals would shift the cadence
    vi.advanceTimersByTime(1200);
    expect(doc.title).toBe('Commander Night');

    // Third cycle: advance 1200ms more, should flip back to NUDGE_TITLE
    vi.advanceTimersByTime(1200);
    expect(doc.title).toBe(NUDGE_TITLE);

    // Dispose and verify title is restored (baseTitle was never re-captured)
    stop();
    expect(doc.title).toBe('Commander Night');
  });
});
