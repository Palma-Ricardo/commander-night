// Shared modal + card grid: graveyard/exile browsers (§8), chooseTargets card
// grids and pile columns (§7).

import type { ReactNode } from 'react';
import type { Card } from '../../protocol/protocol';
import { CardView, type CardSize } from '../cards/CardView';

export function Modal({ title, onClose, children }: { title: string; onClose?: () => void; children: ReactNode }) {
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

export function CardGrid({ cards, size = 'grid', onCardClick, selectedIds }: {
  cards: Card[];
  size?: CardSize;
  onCardClick?: (card: Card) => void;
  selectedIds?: string[];
}) {
  if (cards.length === 0) return <p className="muted">empty</p>;
  return (
    <div className="card-grid">
      {cards.map(c => (
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
  );
}
