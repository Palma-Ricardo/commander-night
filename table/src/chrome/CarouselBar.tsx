// The carousel's DOM chrome (prompts-on-the-table §4.4): title, browse filter,
// page controls, close — a thin strip floating just above the canvas fan. The
// cards themselves are canvas actors (TableScene syncCarousel); this bar and
// the scene derive what's open from the same carouselContent, so they can
// never disagree. Prompt mode has no close button — the fan IS the prompt UI
// and lives exactly as long as its ask (decline lives in the corner cluster).

import { useStore } from 'zustand';
import { appStores } from '../app';
import {
  carouselBarBottom, carouselContent, carouselPageCount, type CarouselContent,
} from '../layout/carousel';
import { carouselStore, closeBrowse, pageFor, setFilter, turnPage } from '../scene/carousel-store';

export function CarouselBar() {
  const prompt = useStore(appStores.prompt);
  const state = useStore(appStores.game, s => s.state);
  const ui = useStore(carouselStore);
  const content = carouselContent(prompt, state, ui.browse, ui.filter);
  if (content === undefined) return null;
  return <Bar content={content} filter={ui.filter} />;
}

function Bar({ content, filter }: { content: CarouselContent; filter: string }) {
  const pageCount = carouselPageCount(content.entries.length);
  const page = Math.min(pageFor(content.key), pageCount - 1);
  const browse = content.mode === 'browse';
  const bottom = typeof window !== 'undefined'
    ? carouselBarBottom({ w: window.innerWidth, h: window.innerHeight })
    : 320;

  return (
    <div className="carousel-bar" data-carousel={content.mode} style={{ bottom }}>
      <span className="carousel-title">{content.title}</span>
      {browse && (
        <input
          className="pile-filter"
          type="search"
          placeholder="filter…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      )}
      {content.entries.length === 0 && <span className="muted">{browse && filter !== '' ? 'no match' : 'empty'}</span>}
      {pageCount > 1 && (
        <span className="carousel-pager">
          <button data-car="prev" disabled={page <= 0}
            onClick={() => turnPage(content.key, -1, pageCount)}>◀</button>
          <span>{page + 1}/{pageCount}</span>
          <button data-car="next" disabled={page >= pageCount - 1}
            onClick={() => turnPage(content.key, 1, pageCount)}>▶</button>
        </span>
      )}
      {browse && <button className="carousel-close" data-car="close" onClick={closeBrowse}>✕</button>}
    </div>
  );
}
