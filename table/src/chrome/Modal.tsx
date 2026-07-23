// Shared modal + card grid: the graveyard/exile browser (§8), chooseTargets card
// grids and pile columns (§7). Escape-to-close and, for pile browsers, a name
// filter over the scan ordering (pile.ts). Ported from
// client/src/ui/board/Modal.tsx — the table client's card-grid prompts (choosePile,
// chooseTargets when candidates carry a `cards` array, distribute rows) render in
// DOM modals over the canvas; on-felt pile spreads (§8) are deferred to T4.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Card } from '@night/core/protocol/protocol';
import { CardView, type CardSize } from './CardView';
import { filterSortPile } from './pile';

export function Modal({ title, onClose, children, suspendsShortcuts = false }: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  /** True for modals that are NOT prompt UI (pile browsers, the concede
   *  confirm): marks the backdrop so chrome/shortcuts.ts's document-level
   *  listener bails out. Escape here is handled by THIS component's own
   *  window listener below; the document listener sits closer to the root
   *  and — because keydown bubbles target → document → window — would
   *  otherwise fire first and answer/cancel whatever prompt happens to be
   *  pending underneath, before this handler ever runs. Do not set this on
   *  PromptDock's modals: those ARE the prompt UI and must keep receiving
   *  shortcuts (Enter to submit a chooseTargets grid, etc). */
  suspendsShortcuts?: boolean;
}) {
  // Escape closes. Backdrop-click alone meant a keyboard-driven player had to
  // reach for the mouse to leave a graveyard.
  useEffect(() => {
    if (onClose === undefined) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={suspendsShortcuts ? 'modal-backdrop modal-suspends-shortcuts' : 'modal-backdrop'} onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <header>
          <h3>{title}</h3>
          {onClose !== undefined && <button className="modal-close" onClick={onClose}>✕</button>}
        </header>
        {children}
      </div>
    </div>
  );
}

export function CardGrid({ cards, size = 'grid', onCardClick, selectedIds, browsable = false }: {
  cards: Card[];
  size?: CardSize;
  onCardClick?: (card: Card) => void;
  selectedIds?: string[];
  /** Pile browsers (§8): scan ordering + a name filter. Prompt grids keep
   *  server candidate order — reordering a choice list would be lying. */
  browsable?: boolean;
}) {
  const [filter, setFilter] = useState('');
  const shown = useMemo(
    () => (browsable ? filterSortPile(cards, filter) : cards),
    [browsable, cards, filter],
  );

  if (cards.length === 0) return <p className="muted">empty</p>;
  return (
    <>
      {browsable && (
        <input
          className="pile-filter"
          type="search"
          placeholder={`filter ${cards.length} cards…`}
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      )}
      <div className="card-grid">
        {shown.map(c => (
          <CardView
            key={c.id}
            card={c}
            size={size}
            priority={2}
            onClickOverride={onCardClick !== undefined ? () => onCardClick(c) : undefined}
            selectedOverride={selectedIds?.includes(c.id)}
          />
        ))}
      </div>
      {browsable && shown.length === 0 && <p className="muted">no card matches “{filter}”</p>}
    </>
  );
}
