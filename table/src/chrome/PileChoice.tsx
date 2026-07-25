// choosePile's surface (prompts-on-the-table §5): two card fans side by side
// in screen space — no backdrop, no modal — with a pick button per fan. The
// InstructionLine above already carries the ask's message. Either pile may be
// empty (§8).

import { useStore } from 'zustand';
import { appActions, appStores } from '../app';
import { CardView } from './CardView';

export function PileChoice() {
  const prompt = useStore(appStores.prompt);
  const p = prompt.pending;
  if (p?.kind !== 'choosePile') return null;

  const busy = prompt.inflight;
  return (
    <div className={`pile-choice${busy ? ' dock-busy' : ''}`}>
      {([0, 1] as const).map(i => (
        <div key={i} className="pile-col">
          <button className="primary" data-answer={`pile-${i}`} disabled={busy}
            onClick={() => void appActions.answerPrompt(p.promptId, { type: 'pile', index: i })}>
            Choose pile {i + 1}
          </button>
          <div className="pile-fan">
            {p.piles[i].length === 0 && <p className="muted">empty</p>}
            {p.piles[i].map(c => (
              <CardView key={c.id} card={c} size="small" interactive={false} priority={2} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
