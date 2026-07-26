// payMana's surface (prompts-on-the-table §5.3): the remaining cost in mana
// symbols plus pool-spend pips, anchored below the paying object's card. The
// anchor chain is the M7 `for` id first (an anchoring hint, never
// load-bearing), the top of the stack when it's absent (older bridge), and
// the corner column above the cluster when nothing resolves — the panel must
// render sanely with no anchor forever. Sources stay highlighted on the felt
// (canvas rings); Cancel lives in the corner cluster (promptControls).
//
// T10 auto-mana (§6): while the solver drives, the panel is the flash of the
// cost being paid — a beat, not a wait; when it stands down, the same manual
// panel with a note saying so.

import { useStore } from 'zustand';
import { appActions, appStores } from '../app';
import type { Id, Prompt } from '@night/core/protocol/protocol';
import type { PromptStoreState } from '@night/core/stores/prompt';
import { parseManaCost } from '@night/core/state/mana';
import { me } from '@night/core/state/selectors';
import { ManaSymbols } from './ManaSymbols';
import { useLiveAnchor } from './use-live-anchor';

const POOL_ORDER = ['W', 'U', 'B', 'R', 'G', 'C'] as const;
const PANEL_W = 320;   // clamp estimate; the real panel wraps within max-width

export function PayPanel() {
  const prompt = useStore(appStores.prompt);
  const state = useStore(appStores.game, s => s.state);
  const p = prompt.pending;
  if (p?.kind !== 'payMana' || state === undefined) return null;
  const stackTop = state.stack[state.stack.length - 1];
  return <Panel key={p.promptId} p={p} prompt={prompt}
    stackTopId={stackTop?.card?.id ?? stackTop?.id}
    pool={me(state)?.manaPool} />;
}

function Panel({ p, prompt, stackTopId, pool }: {
  p: Extract<Prompt, { kind: 'payMana' }>;
  prompt: PromptStoreState;
  stackTopId: Id | undefined;
  pool: Record<(typeof POOL_ORDER)[number], number> | undefined;
}) {
  const anchor = useLiveAnchor([p.for, stackTopId]);
  const busy = prompt.inflight;
  const held = pool !== undefined ? POOL_ORDER.filter(c => pool[c] > 0) : [];

  const hint =
    prompt.autoPay === 'paying' ? 'auto-mana is paying…'
    : prompt.autoPay === 'stood-down' ? 'auto-mana stood down — pay manually'
    : (p.sources ?? []).length > 0 ? 'click a highlighted source' : undefined;

  // Below the anchored card, clamped on-screen; anchorless ⇒ the corner column.
  const style = anchor !== undefined
    ? {
        left: Math.max(12, Math.min(anchor.left + anchor.width / 2 - PANEL_W / 2,
          window.innerWidth - PANEL_W - 12)),
        top: Math.min(anchor.top + anchor.height + 10, window.innerHeight - 72),
      }
    : undefined;

  return (
    <div style={style} className={
      `pay-panel${anchor !== undefined ? ' pay-anchored' : ''}` +
      `${prompt.autoPay === 'paying' ? ' pay-auto' : ''}${busy ? ' dock-busy' : ''}`
    }>
      <span className="dock-cost"><ManaSymbols symbols={parseManaCost(p.remaining)} /></span>
      {hint !== undefined && <span className="dock-hint">{hint}</span>}
      {held.map(c => (
        <button key={c} className="pool-spend" data-mana={c} disabled={busy} title={`pay ${c} from pool`}
          onClick={() => void appActions.answerPrompt(p.promptId, { type: 'mana', color: c })}>
          <ManaSymbols symbols={[c]} /> ×{pool![c]}
        </button>
      ))}
    </div>
  );
}
