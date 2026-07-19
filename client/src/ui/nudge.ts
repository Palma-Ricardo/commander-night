// Background-tab priority nudge (C5). While a `priority` prompt is pending and
// the tab is hidden, alternate the document title. Restores on foreground, on
// the prompt resolving, and on dispose.
//
// Title flash is the whole feature — the chime was cut at design time, so
// there is no audio asset, no autoplay unlock, and no settings surface.
//
// `document` is injected: a genuinely backgrounded tab is not drivable from
// Playwright, so this state machine is proven headlessly (design §13).

import type { StoreApi } from 'zustand/vanilla';
import type { PromptStoreState } from '../stores/prompt';

export interface NudgeDoc {
  hidden: boolean;
  title: string;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

export interface NudgeOpts {
  doc: NudgeDoc;
  prompt: StoreApi<PromptStoreState>;
  /** Alternation period; default 1200 ms. */
  periodMs?: number;
}

export const NUDGE_TITLE = '● Your turn';

export function startNudge(opts: NudgeOpts): () => void {
  const { doc, prompt } = opts;
  const period = opts.periodMs ?? 1200;

  let timer: ReturnType<typeof setInterval> | null = null;
  let baseTitle = '';
  let showingNudge = false;

  const shouldFlash = (): boolean =>
    doc.hidden && prompt.getState().pending?.kind === 'priority';

  function start(): void {
    if (timer !== null) return;
    baseTitle = doc.title;          // captured while quiescent — never a nudge title
    showingNudge = false;
    timer = setInterval(() => {
      showingNudge = !showingNudge;
      doc.title = showingNudge ? NUDGE_TITLE : baseTitle;
    }, period);
  }

  function stop(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    doc.title = baseTitle;
    showingNudge = false;
  }

  function evaluate(): void {
    if (shouldFlash()) start();
    else stop();
  }

  const unsubscribe = prompt.subscribe(evaluate);
  doc.addEventListener('visibilitychange', evaluate);
  evaluate();

  return () => {
    unsubscribe();
    doc.removeEventListener('visibilitychange', evaluate);
    stop();
  };
}
