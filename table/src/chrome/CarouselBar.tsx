// The carousel's DOM chrome (prompts-on-the-table §4.4): title, browse filter,
// page controls, close — a thin strip floating just above the canvas fan. The
// cards themselves are canvas actors (TableScene syncCarousel); this bar and
// the scene derive what's open from the same carouselContent, so they can
// never disagree. Prompt mode has no close button — the fan IS the prompt UI
// and lives exactly as long as its ask (decline lives in the corner cluster).

import { useStore } from 'zustand';
import { appStores } from '../app';
import {
  CAROUSEL_FILTER_MIN, carouselBarBottom, carouselContent, type CarouselContent,
} from '../layout/carousel';
import { carouselStore, closeBrowse, filterFor, setFilter, setOffset } from '../scene/carousel-store';

export function CarouselBar() {
  const prompt = useStore(appStores.prompt);
  const state = useStore(appStores.game, s => s.state);
  const ui = useStore(carouselStore);
  const content = carouselContent(prompt, state, ui.browse, ui.filter, ui.viewKey);
  if (content === undefined) return null;
  return <Bar content={content} filter={filterFor(content.key)}
    offset={ui.viewKey === content.key ? ui.offset : 0} maxOffset={ui.maxOffset} />;
}

interface BarProps {
  content: CarouselContent;
  filter: string;
  offset: number;
  /** Measured by the scene's last layout — 0 while the strip fits, which is
   *  exactly when there is nothing to seek and the slider stays away. */
  maxOffset: number;
}

function Bar({ content, filter, offset, maxOffset }: BarProps) {
  const browse = content.mode === 'browse';
  // Browse has always had a filter; the other modes earn one once the set is too
  // long to read at a glance — which is the whole of Issues.txt #14, a library
  // search handing you 99 cards with no way to find one (see CAROUSEL_FILTER_MIN).
  const filterable = browse || content.total > CAROUSEL_FILTER_MIN;
  const filtered = filter.trim() !== '';
  const bottom = typeof window !== 'undefined'
    ? carouselBarBottom({ w: window.innerWidth, h: window.innerHeight })
    : 320;

  return (
    <div className="carousel-bar" data-carousel={content.mode} style={{ bottom }}>
      <span className="carousel-title">{content.title}</span>
      {filterable && (
        <input
          className="pile-filter"
          type="search"
          placeholder="filter…"
          value={filter}
          onChange={e => setFilter(content.key, e.target.value)}
        />
      )}
      {content.entries.length === 0 && <span className="muted">{filtered ? 'no match' : 'empty'}</span>}
      {filtered && content.entries.length > 0 && (
        <span className="carousel-count">{content.entries.length} of {content.total}</span>
      )}
      {/* One continuous seek, not page buttons (#8) — the wheel and ←/→ push the
          same offset, so the thumb is always where the strip is. */}
      {maxOffset > 0 && (
        <input
          className="carousel-seek"
          data-car="seek"
          type="range"
          min={0}
          max={maxOffset}
          step={1}
          value={Math.min(offset, maxOffset)}
          aria-label="scroll"
          onChange={e => setOffset(content.key, Number(e.target.value), maxOffset)}
        />
      )}
      {browse && <button className="carousel-close" data-car="close" onClick={closeBrowse}>✕</button>}
    </div>
  );
}
