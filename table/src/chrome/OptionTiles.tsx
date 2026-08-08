// chooseOption's surface (prompts-on-the-table §5.4): pick one *string* —
// modes, colors, creature types, numbers-as-choices, often with no card at
// all. Large screen-space tiles, centred; when `actedOn` resolves to a card
// this seat can see, it renders beside the tiles for context (the resolving
// object whose mode-text the options usually are). Card-per-option is
// explicitly not the design — the options are strings. Decline (when
// `required:false`) lives in the corner cluster.

import { useStore } from 'zustand';
import { appActions, appStores } from '../app';
import { findObject } from '@night/core/state/selectors';
import { CardView } from './CardView';
import { ManaText } from './ManaSymbols';

export function OptionTiles() {
  const prompt = useStore(appStores.prompt);
  const state = useStore(appStores.game, s => s.state);
  const p = prompt.pending;
  if (p?.kind !== 'chooseOption') return null;

  const busy = prompt.inflight;
  const context = state !== undefined && prompt.actedOn !== undefined
    ? findObject(state, prompt.actedOn) : undefined;

  return (
    <div className="option-tiles">
      {context !== undefined && (
        <div className="option-context">
          <CardView card={context} size="small" interactive={false} />
        </div>
      )}
      <div className={`option-tile-list${p.options.length > 4 ? ' option-tile-col' : ''}`}>
        {p.options.map(o => (
          <button key={o.key} className="option-tile" data-option-key={o.key} disabled={busy}
            onClick={() => void appActions.answerPrompt(p.promptId, { type: 'option', key: o.key })}>
            <ManaText text={o.text} />
          </button>
        ))}
      </div>
    </div>
  );
}
