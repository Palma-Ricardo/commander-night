// Shared modal + card grid: graveyard/exile browsers (§8), chooseTargets card
// grids and pile columns (§7). C5 adds Escape-to-close and, for pile browsers,
// a name filter over the C5 scan ordering (pile.ts).

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Card } from '../../protocol/protocol';
import { CardView, type CardSize } from '../cards/CardView';
import { filterSortPile } from './pile';

export function Modal({ title, onClose, children }: { title: string; onClose?: () => void; children: ReactNode }) {
  // C5: Escape closes. Backdrop-click alone meant a keyboard-driven player had
  // to reach for the mouse to leave a graveyard.
  useEffect(() => {
    if (onClose === undefined) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
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
