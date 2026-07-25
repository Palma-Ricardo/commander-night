// Hand-mode paging chrome (prompts-on-the-table §4.4): once the hand outgrows
// HAND_PAGE_THRESHOLD, layoutHand pages instead of cramming, and this strip —
// pinned over the hand band's right shoulder — turns the pages. The cards are
// ordinary hand actors, so drag-to-cast works identically from any page.

import { useStore } from 'zustand';
import { appStores } from '../app';
import { handPageCount } from '../layout/screen';
import { carouselStore, setHandPage } from '../scene/carousel-store';

export function HandPager() {
  const handSize = useStore(appStores.game, s => s.state?.me.hand.length ?? 0);
  const raw = useStore(carouselStore, s => s.handPage);
  const pages = handPageCount(handSize);
  if (pages <= 1) return null;
  const page = Math.min(raw, pages - 1);
  return (
    <span className="hand-pager">
      <button data-hand="prev" disabled={page <= 0} onClick={() => setHandPage(page - 1)}>◀</button>
      <span>{page + 1}/{pages}</span>
      <button data-hand="next" disabled={page >= pages - 1} onClick={() => setHandPage(page + 1)}>▶</button>
    </span>
  );
}
