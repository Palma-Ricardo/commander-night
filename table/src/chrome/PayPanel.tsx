// payMana's screen-space surface (prompts-on-the-table §5.3): the remaining
// cost in mana symbols plus pool-spend pips, docked in the corner column above
// the cluster. Sources stay highlighted on the felt (canvas rings) exactly as
// before; Cancel lives in the corner cluster (promptControls). T10 moves this
// panel under the paying object via the M7 `for` anchor — until then the
// no-anchor fallback position (§5.3: "docks beside the corner cluster") is the
// only position.

import { useStore } from 'zustand';
import { appActions, appStores } from '../app';
import { parseManaCost } from '@night/core/state/mana';
import { me } from '@night/core/state/selectors';
import { ManaSymbols } from './ManaSymbols';

const POOL_ORDER = ['W', 'U', 'B', 'R', 'G', 'C'] as const;

export function PayPanel() {
  const prompt = useStore(appStores.prompt);
  const state = useStore(appStores.game, s => s.state);
  const p = prompt.pending;
  if (p?.kind !== 'payMana' || state === undefined) return null;

  const busy = prompt.inflight;
  const pool = me(state)?.manaPool;
  const held = pool !== undefined ? POOL_ORDER.filter(c => pool[c] > 0) : [];

  return (
    <div className={`pay-panel${busy ? ' dock-busy' : ''}`}>
      <span className="dock-cost"><ManaSymbols symbols={parseManaCost(p.remaining)} /></span>
      {(p.sources ?? []).length > 0 && <span className="dock-hint">click a highlighted source</span>}
      {held.map(c => (
        <button key={c} className="pool-spend" data-mana={c} disabled={busy} title={`pay ${c} from pool`}
          onClick={() => void appActions.answerPrompt(p.promptId, { type: 'mana', color: c })}>
          <ManaSymbols symbols={[c]} /> ×{pool![c]}
        </button>
      ))}
    </div>
  );
}
