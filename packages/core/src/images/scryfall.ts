// Scryfall image resolution (design §9). Identity is set+collectorNumber
// (protocol §1: no client card DB); resolution is a soft dependency — every
// miss ends at the text frame, so an unresolved image is cosmetic, never
// functional.
//
// Each card gets a ladder of lookup URLs, walked through a queue paced at
// ~8 req/s (Scryfall's courtesy limit), prioritized by visibility:
// hand/commanders (0) → battlefield (1) → piles (2).
//
//   - Real cards: cards/{set}/{number} (lowercased set), then
//     cards/named?exact=<name> (XMage set codes drift).
//   - Tokens (XMage ships them with no collector number and a " Token" name
//     suffix): a name is not unique among tokens — one set has several Spirits
//     — so these go through cards/search with include_extras, narrowed by
//     colour and stats, degrading set → stats → colour, then the old
//     named?exact rungs (Scryfall files token printings in t-prefixed sets:
//     "Goblin Token" in WAR → twar "Goblin"). Identity is set+name+imageNumber,
//     never the stats: those are current values and anthems move them.
//   - Ladder exhausted → recorded as a miss (debug-panel list, §12); the card
//     renders as a text frame.
//
// Resolved URLs are cached memory + localStorage (cn.imageCache); the <img>
// then hits Scryfall's CDN directly, which the browser caches — steady-state
// games make near-zero API calls. Face-down cards never reach this module
// (bundled card back, §9).
//
// Framework-free zustand store; fetch/clock/timer injected for tests.

import { createStore, type StoreApi } from 'zustand/vanilla';
import { KEYS, type KV } from '../stores/storage';

/** 0 = hand/commanders, 1 = battlefield, 2 = piles/log refs. */
export type ImagePriority = 0 | 1 | 2;

/** The token-only fields that separate two arts sharing a set and a name. */
export interface TokenFields {
  /** XMage's art index within set+name (protocol §6). Identity only, never a URL part. */
  imageNumber?: number;
  /** Narrows the Scryfall search. P/T are *current* — anthems move them, so the ladder degrades. */
  colors?: string[];
  power?: string;
  toughness?: string;
}

export interface CardIdentity extends TokenFields {
  set: string;
  number: string;
  name: string;
  token?: boolean;
}

export interface ImageEntry {
  status: 'loading' | 'ok' | 'miss';
  url?: string;
  name: string;
}

export interface ScryfallState { images: Record<string, ImageEntry> }

export interface ScryfallResolver {
  store: StoreApi<ScryfallState>;
  /** Queue a lookup (dedupes; a higher priority re-request jumps the queue). */
  resolve(card: CardIdentity, priority: ImagePriority): void;
  /** Cache key for a card — the store's images index. */
  keyOf(card: { set: string; number: string; name?: string } & TokenFields): string;
  misses(): { key: string; name: string }[];
  dispose(): void;
}

interface QueueEntry {
  key: string;
  name: string;
  priority: number;
  /** Remaining lookup URLs, most specific first; empty after the last fails. */
  urls: string[];
}

export interface ScryfallOpts {
  kv: KV;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Pace between request starts; default 125 ms ≈ 8 req/s. */
  minIntervalMs?: number;
  apiBase?: string;
}

const IMAGE_CACHE_LIMIT = 2000;   // localStorage safety valve, not a hot path

export function createScryfallResolver(opts: ScryfallOpts): ScryfallResolver {
  const fetchFn = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = opts.now ?? Date.now;
  const minInterval = opts.minIntervalMs ?? 125;
  const apiBase = opts.apiBase ?? 'https://api.scryfall.com';

  const store = createStore<ScryfallState>(() => ({ images: {} }));
  const queue: QueueEntry[] = [];
  let persisted: Record<string, string> = {};
  let lastDispatch = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  try {
    persisted = JSON.parse(opts.kv.get(KEYS.imageCache) ?? '{}') as Record<string, string>;
  } catch {
    opts.kv.remove(KEYS.imageCache);
  }

  // Tokens all arrive with an empty number — key those by name instead, or
  // every token from one set would share a single "{set}/" entry. Name alone
  // is still not enough: a Chishiro deck makes a 1/1 white Spirit and a 2/2 red
  // Spirit, which collided onto one key and one art (live, 2026-07-20). XMage's
  // imageNumber is the art's real identity and is stable under anthems; the
  // colour/stat suffix is the fallback for older bridges that omit it.
  const tokenSuffix = (card: TokenFields): string => {
    if (card.imageNumber !== undefined) return `#${card.imageNumber}`;
    const colors = [...(card.colors ?? [])].sort().join('').toLowerCase() || 'c';
    const pt = card.power !== undefined && card.toughness !== undefined
      ? `${card.power}-${card.toughness}` : '';
    return `#${colors}${pt === '' ? '' : `/${pt}`}`;
  };

  const keyOf = (card: { set: string; number: string; name?: string } & TokenFields) =>
    card.number === ''
      ? `${card.set.toLowerCase()}/${(card.name ?? '').toLowerCase()}${tokenSuffix(card)}`
      : `${card.set.toLowerCase()}/${card.number}`;

  function lookupLadder(card: CardIdentity): string[] {
    const set = card.set.toLowerCase();
    const byName = (name: string, setCode?: string) =>
      `${apiBase}/cards/named?exact=${encodeURIComponent(name)}`
      + (setCode !== undefined ? `&set=${encodeURIComponent(setCode)}` : '');
    if (card.token !== true && card.number !== '') {
      return [
        `${apiBase}/cards/${encodeURIComponent(set)}/${encodeURIComponent(card.number)}`,
        byName(card.name),
      ];
    }
    const bare = card.name.replace(/ [Tt]oken$/, '');

    // named?exact assumes the name is unique, which for tokens it is not —
    // "Spirit" matches every Spirit ever printed and the endpoint picks one.
    // /cards/search can filter on colour and stats, but it hides token
    // printings unless include_extras is set.
    const search = (...filters: string[]) =>
      `${apiBase}/cards/search?include_extras=true&unique=cards&order=released`
      + `&q=${encodeURIComponent([`!"${bare}"`, 't:token', ...filters].join(' '))}`;

    const colors = [...(card.colors ?? [])].sort().join('').toLowerCase();
    const colorFilter = colors === '' ? 'c=c' : `c=${colors}`;
    const stats = card.power !== undefined && card.toughness !== undefined
      ? [`pow=${card.power}`, `tou=${card.toughness}`] : [];
    const inSet = set === '' ? [] : [`set:t${set}`];

    const urls: string[] = [];
    if (stats.length > 0) {
      // Most specific first; then drop the set, then the stats — a token under
      // an anthem reports buffed P/T that no printing will match.
      if (inSet.length > 0) urls.push(search(...stats, colorFilter, ...inSet));
      urls.push(search(...stats, colorFilter));
    }
    if (inSet.length > 0) urls.push(search(colorFilter, ...inSet));
    urls.push(search(colorFilter));
    // Last resort: the old name-only ladder, for tokens Scryfall files oddly.
    if (set !== '') urls.push(byName(bare, `t${set}`), byName(bare, set));
    urls.push(byName(bare));
    return urls;
  }

  function put(key: string, entry: ImageEntry): void {
    store.setState(s => ({ images: { ...s.images, [key]: entry } }));
  }

  function persist(key: string, url: string): void {
    persisted[key] = url;
    const keys = Object.keys(persisted);
    if (keys.length > IMAGE_CACHE_LIMIT) delete persisted[keys[0]!];
    try {
      opts.kv.set(KEYS.imageCache, JSON.stringify(persisted));
    } catch { /* quota — memory cache still works */ }
  }

  function schedule(): void {
    if (disposed || timer !== null || queue.length === 0) return;
    const delay = Math.max(0, lastDispatch + minInterval - now());
    timer = setTimeout(() => {
      timer = null;
      dispatch();
      schedule();
    }, delay);
  }

  function takeBest(): QueueEntry | undefined {
    if (queue.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < queue.length; i++) {
      if (queue[i]!.priority < queue[best]!.priority) best = i;
    }
    return queue.splice(best, 1)[0];
  }

  function dispatch(): void {
    const entry = takeBest();
    if (entry === undefined) return;
    lastDispatch = now();
    const url = entry.urls[0]!;

    void fetchFn(url)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: unknown) => {
        const img = imageUrlFrom(body);
        if (img === undefined) throw new Error('no image_uris');
        put(entry.key, { status: 'ok', url: img, name: entry.name });
        persist(entry.key, img);
      })
      .catch(() => {
        const rest = entry.urls.slice(1);
        if (rest.length > 0) {
          queue.push({ ...entry, urls: rest });
          schedule();
        } else {
          put(entry.key, { status: 'miss', name: entry.name });
          if (import.meta.env.DEV) console.warn(`[scryfall] miss ${entry.key} (${entry.name})`);
        }
      });
  }

  return {
    store,
    keyOf,
    resolve(card, priority): void {
      const key = keyOf(card);
      const existing = store.getState().images[key];
      if (existing !== undefined) {
        if (existing.status === 'loading') {
          const queued = queue.find(q => q.key === key);
          if (queued !== undefined && priority < queued.priority) queued.priority = priority;
        }
        return;
      }
      const cached = persisted[key];
      if (cached !== undefined) {
        put(key, { status: 'ok', url: cached, name: card.name });
        return;
      }
      put(key, { status: 'loading', name: card.name });
      queue.push({ key, name: card.name, priority, urls: lookupLadder(card) });
      schedule();
    },
    misses(): { key: string; name: string }[] {
      return Object.entries(store.getState().images)
        .filter(([, e]) => e.status === 'miss')
        .map(([key, e]) => ({ key, name: e.name }));
    },
    dispose(): void {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queue.length = 0;
    },
  };
}

function imageUrlFrom(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  // /cards/search returns a list; /cards/named and /cards/{set}/{n} a bare card.
  const list = (body as { data?: unknown[] }).data;
  if (Array.isArray(list)) return list.length === 0 ? undefined : imageUrlFrom(list[0]);
  const b = body as { image_uris?: Record<string, string>; card_faces?: { image_uris?: Record<string, string> }[] };
  const uris = b.image_uris ?? b.card_faces?.[0]?.image_uris;
  return uris?.['normal'] ?? uris?.['large'] ?? uris?.['small'];
}
