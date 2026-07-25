// playerRequest's surface (prompts-on-the-table §5): a corner pop-panel for
// the rare meta dialog (rollback permission and kin) — title, message, an
// option button per answer. Plain on purpose; no backdrop.

import { useStore } from 'zustand';
import { appActions, appStores } from '../app';

export function RequestPanel() {
  const prompt = useStore(appStores.prompt);
  const p = prompt.pending;
  if (p?.kind !== 'playerRequest') return null;

  const busy = prompt.inflight;
  return (
    <div className={`request-panel${busy ? ' dock-busy' : ''}`}>
      <h4>{p.requestKey}</h4>
      <p>{p.message}</p>
      <div className="request-options">
        {p.options.map(o => (
          <button key={o.key} data-option-key={o.key} disabled={busy}
            onClick={() => void appActions.answerPrompt(p.promptId, { type: 'option', key: o.key })}>
            {o.text}
          </button>
        ))}
      </div>
    </div>
  );
}
