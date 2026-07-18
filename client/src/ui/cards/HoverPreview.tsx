// The enlarged hover preview (§9): image when resolved, text frame as the
// preview body when not. One global instance, fixed to the lower-left, fed by
// the hover store.

import { useStore } from 'zustand';
import { appScryfall } from '../../app';
import { hoverStore } from '../hover';
import { TextFrame } from './CardView';

export function HoverPreview() {
  const card = useStore(hoverStore, s => s.card);
  const image = useStore(appScryfall.store, s => (card !== undefined ? s.images[appScryfall.keyOf(card)] : undefined));
  if (card === undefined) return null;
  return (
    <div className="hover-preview">
      {image?.status === 'ok'
        ? <img src={image.url} alt={card.name} />
        : <TextFrame card={card} size="preview" />}
      {image?.status === 'ok' && card.text.length > 0 && (
        <div className="hover-oracle">{card.text.map((l, i) => <p key={i}>{l}</p>)}</div>
      )}
    </div>
  );
}
