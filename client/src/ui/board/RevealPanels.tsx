// revealed / lookedAt windows (§8): floating panels while present in state —
// they leave via patches (or the next keyframe), never by client dismissal.
// Cards stay interactive: choose-from-revealed prompts list their ids as
// candidates.

import type { GameState } from '../../protocol/protocol';
import { CardView } from '../cards/CardView';

export function RevealPanels({ state }: { state: GameState }) {
  const windows = [
    ...(state.revealed ?? []).map(w => ({ ...w, private: false })),
    ...(state.lookedAt ?? []).map(w => ({ ...w, private: true })),
  ];
  if (windows.length === 0) return null;
  return (
    <div className="reveal-panels">
      {windows.map((w, i) => (
        <div key={`${w.private ? 'l' : 'r'}-${i}`} className="reveal-panel">
          <h4>{w.private && <span title="only you see this">🕵 </span>}{w.name}</h4>
          <div className="reveal-cards">
            {w.cards.map(c => <CardView key={c.id} card={c} size="grid" priority={2} />)}
          </div>
        </div>
      ))}
    </div>
  );
}
