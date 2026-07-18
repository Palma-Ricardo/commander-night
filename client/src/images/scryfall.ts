// Scryfall image resolution (design §9). Identity is set+collectorNumber
// (protocol §1: no client card DB); resolution is a soft dependency — every
// miss ends at the text frame, so an unresolved image is cosmetic, never
// functional.
//
//   1. GET cards/{set}/{number} (lowercased set) through a queue paced at
//      ~8 req/s (Scryfall's courtesy limit), prioritized by visibility:
//      hand/commanders (0) → battlefield (1) → piles (2).
//   2. Miss → one retry via cards/named?exact=<name> (XMage set codes drift).
//   3. Still missing → recorded as a miss (debug-panel list, §12); the card
//      renders as a text frame.
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

export interface CardIdentity { set: string; number: string; name: string }

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
  keyOf(card: { set: string; number: string }): string;
  misses(): { key: string; name: string }[];
  dispose(): void;
}

interface QueueEntry {
  key: string;
  card: CardIdentity;
  priority: number;
  mode: 'byId' | 'byName';
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

  const keyOf = (card: { set: string; number: string }) =>
    `${card.set.toLowerCase()}/${card.number}`;

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
    const { key, card, mode } = entry;
    const url = mode === 'byId'
      ? `${apiBase}/cards/${encodeURIComponent(card.set.toLowerCase())}/${encodeURIComponent(card.number)}`
      : `${apiBase}/cards/named?exact=${encodeURIComponent(card.name)}`;

    void fetchFn(url)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: unknown) => {
        const img = imageUrlFrom(body);
        if (img === undefined) throw new Error('no image_uris');
        put(key, { status: 'ok', url: img, name: card.name });
        persist(key, img);
      })
      .catch(() => {
        if (mode === 'byId') {
          // one retry by exact name (§9); front of its priority class
          queue.push({ ...entry, mode: 'byName' });
          schedule();
        } else {
          put(key, { status: 'miss', name: card.name });
          if (import.meta.env.DEV) console.warn(`[scryfall] miss ${key} (${card.name})`);
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
      queue.push({ key, card, priority, mode: 'byId' });
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
  const b = body as { image_uris?: Record<string, string>; card_faces?: { image_uris?: Record<string, string> }[] };
  const uris = b.image_uris ?? b.card_faces?.[0]?.image_uris;
  return uris?.['normal'] ?? uris?.['large'] ?? uris?.['small'];
}
