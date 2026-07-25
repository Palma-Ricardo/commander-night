// chooseAbility's surface (prompts-on-the-table §5.4): a vertical option list
// anchored under the card the player just acted on. The wire `sourceId` is in
// practice never set (bridge PromptTranslator: "No source id exists on the
// view"), but the prompt store's `actedOn` knows what was clicked — anchor
// there, falling back to screen-centre when nothing resolves. The anchor is
// re-read on a short interval: the source actor may still be easing under the
// camera flush when the ask arrives.

import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { appActions, appStores } from '../app';
import type { Id } from '@night/core/protocol/protocol';
import { getActiveScene } from '../scene/TableScene';
import type { ScreenAnchor } from '../scene/interaction';

export function AbilityOptions() {
  const prompt = useStore(appStores.prompt);
  const p = prompt.pending;
  if (p?.kind !== 'chooseAbility') return null;
  return <Panel key={p.promptId} promptId={p.promptId} busy={prompt.inflight}
    options={p.options} actedOn={prompt.actedOn} />;
}

function Panel({ promptId, busy, options, actedOn }: {
  promptId: number; busy: boolean;
  options: { id: Id; text: string }[];
  actedOn: Id | undefined;
}) {
  const anchor = useLiveAnchor(actedOn);

  // Below the anchored card, clamped on-screen; anchorless ⇒ centred by CSS.
  const style = anchor !== undefined
    ? {
        left: Math.max(12, Math.min(anchor.left + anchor.width / 2 - 140, window.innerWidth - 292)),
        top: Math.min(anchor.top + anchor.height + 10, window.innerHeight - 60 - options.length * 44),
      }
    : undefined;

  return (
    <div className={`option-list${anchor === undefined ? ' option-list-center' : ''}`} style={style}>
      {options.map(o => (
        <button key={o.id} data-option-id={o.id} disabled={busy}
          onClick={() => void appActions.answerPrompt(promptId, { type: 'object', objectId: o.id })}>
          {o.text}
        </button>
      ))}
    </div>
  );
}

/** The acted-on actor's live on-screen rect, polled so the panel tracks a
 *  card that is still settling. Undefined when nothing resolves. */
function useLiveAnchor(objectId: Id | undefined): ScreenAnchor | undefined {
  const [anchor, setAnchor] = useState<ScreenAnchor | undefined>(undefined);
  useEffect(() => {
    if (objectId === undefined) { setAnchor(undefined); return; }
    const read = (): void => {
      const a = getActiveScene()?.anchorFor(objectId);
      setAnchor(prev => sameAnchor(prev, a) ? prev : a);
    };
    read();
    const t = setInterval(read, 200);
    return () => clearInterval(t);
  }, [objectId]);
  return anchor;
}

function sameAnchor(a: ScreenAnchor | undefined, b: ScreenAnchor | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1
    && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
}
