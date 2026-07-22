// Scryfall resolver (design §9/§13): queue pacing (~8 req/s), visibility
// priority ordering, dedupe, the lookup ladder (byId → byName for real cards;
// a colour/stat-narrowed cards/search degrading to the name-only rungs for
// tokens), token identity via imageNumber, miss list, and the localStorage
// cache short-circuit.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScryfallResolver, type ScryfallResolver } from '../src/images/scryfall';
import { memoryKV, type KV } from '../src/stores/storage';

interface FakeResponse { ok: boolean; status: number; json(): Promise<unknown> }

const okBody = (url: string) => ({ image_uris: { normal: `https://cdn/${url}` } });

function fakeFetch(failFor: (url: string) => boolean = () => false) {
  const calls: string[] = [];
  const fn = (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const res: FakeResponse = failFor(url)
      ? { ok: false, status: 404, json: () => Promise.resolve({}) }
      : { ok: true, status: 200, json: () => Promise.resolve(okBody(url)) };
    return Promise.resolve(res as unknown as Response);
  };
  return { calls, fn: fn as typeof fetch };
}

const card = (set: string, number: string, name: string) => ({ set, number, name });

let kv: KV;
let resolver: ScryfallResolver | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  kv = memoryKV();
});

afterEach(() => {
  resolver?.dispose();
  resolver = undefined;
  vi.useRealTimers();
});

describe('scryfall resolver', () => {
  it('resolves by set/number and caches to kv', async () => {
    const f = fakeFetch();
    resolver = createScryfallResolver({ kv, fetchFn: f.fn, minIntervalMs: 125 });
    resolver.resolve(card('KHM', '222', 'Lathril, Blade of the Elves'), 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toEqual(['https://api.scryfall.com/cards/khm/222']);
    const entry = resolver.store.getState().images['khm/222'];
    expect(entry).toMatchObject({ status: 'ok', url: 'https://cdn/https://api.scryfall.com/cards/khm/222' });
    expect(JSON.parse(kv.get('cn.imageCache')!)).toHaveProperty(['khm/222']);
  });

  it('dedupes repeated resolves of the same key', async () => {
    const f = fakeFetch();
    resolver = createScryfallResolver({ kv, fetchFn: f.fn });
    const c = card('C21', '263', 'Command Tower');
    resolver.resolve(c, 1);
    resolver.resolve(c, 0);
    resolver.resolve(c, 2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.calls).toHaveLength(1);
  });

  it('paces request starts and serves higher priority first', async () => {
    const f = fakeFetch();
    resolver = createScryfallResolver({ kv, fetchFn: f.fn, minIntervalMs: 125 });
    resolver.resolve(card('AAA', '1', 'Pile Card'), 2);
    resolver.resolve(card('BBB', '2', 'Battlefield Card'), 1);
    resolver.resolve(card('CCC', '3', 'Hand Card'), 0);

    await vi.advanceTimersByTimeAsync(1);      // first dispatch is immediate
    expect(f.calls).toEqual(['https://api.scryfall.com/cards/ccc/3']);
    await vi.advanceTimersByTimeAsync(125);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]).toContain('/bbb/2');
    await vi.advanceTimersByTimeAsync(125);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[2]).toContain('/aaa/1');
  });

  it('falls back to named?exact on a byId miss (§9)', async () => {
    const f = fakeFetch(url => url.includes('/cards/tok/'));
    resolver = createScryfallResolver({ kv, fetchFn: f.fn, minIntervalMs: 125 });
    resolver.resolve(card('TOK', '7', 'Llanowar Elves'), 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.calls).toEqual([
      'https://api.scryfall.com/cards/tok/7',
      'https://api.scryfall.com/cards/named?exact=Llanowar%20Elves',
    ]);
    expect(resolver.store.getState().images['tok/7']?.status).toBe('ok');
  });

  it('records a miss when both lookups fail', async () => {
    const f = fakeFetch(() => true);
    resolver = createScryfallResolver({ kv, fetchFn: f.fn, minIntervalMs: 125 });
    resolver.resolve(card('ZZZ', '99', 'Totally Custom Token'), 2);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.calls).toHaveLength(2);
    expect(resolver.misses()).toEqual([{ key: 'zzz/99', name: 'Totally Custom Token' }]);
  });

  it('tokens search the bare name scoped to the t-prefixed set (live-verified shape)', async () => {
    const f = fakeFetch();
    resolver = createScryfallResolver({ kv, fetchFn: f.fn, minIntervalMs: 125 });
    resolver.resolve({ set: 'WAR', number: '', name: 'Goblin Token', token: true,
      colors: ['R'], power: '1', toughness: '1', imageNumber: 1 }, 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(1);
    expect(decodeURIComponent(f.calls[0]!))
      .toContain('q=!"Goblin" t:token pow=1 tou=1 c=r set:twar');
    expect(resolver.store.getState().images['war/goblin token#1']?.status).toBe('ok');
  });

  it('token ladder degrades stats → set → name-only across the whole rung list', async () => {
    const f = fakeFetch(() => true);   // every rung 404s, so the whole ladder is walked
    resolver = createScryfallResolver({ kv, fetchFn: f.fn, minIntervalMs: 125 });
    resolver.resolve({ set: 'NPH', number: '', name: 'Beast Token', token: true,
      colors: ['G'], power: '3', toughness: '3' }, 1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.calls.map(u => decodeURIComponent(u).replace(/^.*[?&]q=/, '').replace(/^.*cards\//, 'named ')))
      .toEqual([
        '!"Beast" t:token pow=3 tou=3 c=g set:tnph',
        '!"Beast" t:token pow=3 tou=3 c=g',
        '!"Beast" t:token c=g set:tnph',
        '!"Beast" t:token c=g',
        'named named?exact=Beast&set=tnph',
        'named named?exact=Beast&set=nph',
        'named named?exact=Beast',
      ]);
    // Ladder exhausted → a miss, and the card falls back to its text frame (§9).
    expect(resolver.store.getState().images['nph/beast token#g/3-3']?.status).toBe('miss');
  });

  it('two tokens from one set do not collide on the empty collector number', async () => {
    const f = fakeFetch();
    resolver = createScryfallResolver({ kv, fetchFn: f.fn, minIntervalMs: 125 });
    resolver.resolve({ set: 'WAR', number: '', name: 'Goblin Token', token: true, imageNumber: 1 }, 1);
    resolver.resolve({ set: 'WAR', number: '', name: 'Zombie Army Token', token: true, imageNumber: 1 }, 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.calls).toHaveLength(2);
    expect(resolver.store.getState().images['war/goblin token#1']?.status).toBe('ok');
    expect(resolver.store.getState().images['war/zombie army token#1']?.status).toBe('ok');
  });

  // Live 4-player game, 2026-07-20: a Chishiro deck makes both a 1/1 white
  // Spirit and a 2/2 red Spirit with menace. Same name, same art-source set,
  // so both collapsed onto one cache key — the second never even fetched, and
  // rendered the white Spirit's art. Same shape hits Beast/Soldier/Elemental.
  it('same-named tokens differing in stats or colour do not share a key', async () => {
    const f = fakeFetch();
    resolver = createScryfallResolver({ kv, fetchFn: f.fn, minIntervalMs: 125 });
    const white = { set: 'NEC', number: '', name: 'Spirit Token', token: true,
      power: '1', toughness: '1', colors: ['W'] };
    const red = { set: 'NEC', number: '', name: 'Spirit Token', token: true,
      power: '2', toughness: '2', colors: ['R'] };

    expect(resolver.keyOf(white)).not.toBe(resolver.keyOf(red));

    resolver.resolve(white, 1);
    resolver.resolve(red, 1);
    await vi.advanceTimersByTimeAsync(1000);

    expect(f.calls).toHaveLength(2);
    const [a, b] = f.calls.map(u => decodeURIComponent(u));
    expect(a).not.toBe(b);
    expect(a).toContain('pow=1');
    expect(a).toContain('tou=1');
    expect(b).toContain('pow=2');
    expect(b).toContain('tou=2');
  });

  it('token search is scoped to token printings and includes extras', async () => {
    const f = fakeFetch();
    resolver = createScryfallResolver({ kv, fetchFn: f.fn, minIntervalMs: 125 });
    resolver.resolve({ set: 'NEC', number: '', name: 'Spirit Token', token: true,
      power: '2', toughness: '2', colors: ['R'] }, 1);
    await vi.advanceTimersByTimeAsync(1);
    const q = decodeURIComponent(f.calls[0]!);
    // /cards/search omits token printings unless extras are opted in.
    expect(q).toContain('include_extras=true');
    expect(q).toContain('t:token');
    expect(q).toContain('c=r');          // exact colour, not "contains red"
    expect(q).toContain('set:tnec');
  });

  it('prefers XMage imageNumber for token identity, since anthems move P/T', async () => {
    const f = fakeFetch();
    resolver = createScryfallResolver({ kv, fetchFn: f.fn, minIntervalMs: 125 });
    const base = { set: 'NEC', number: '', name: 'Spirit Token', token: true,
      colors: ['W'], imageNumber: 3 };
    // Same token, now under an anthem: P/T changed, art did not.
    const unbuffed = { ...base, power: '1', toughness: '1' };
    const buffed = { ...base, power: '2', toughness: '2' };

    expect(resolver.keyOf(unbuffed)).toBe(resolver.keyOf(buffed));

    resolver.resolve(unbuffed, 1);
    resolver.resolve(buffed, 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.calls).toHaveLength(1);     // one art, one lookup
  });

  it('token search degrades to a stats-free query when the buffed P/T matches nothing', async () => {
    const f = fakeFetch(url => url.includes('pow%3D'));   // every stat-scoped rung 404s
    resolver = createScryfallResolver({ kv, fetchFn: f.fn, minIntervalMs: 125 });
    resolver.resolve({ set: 'NEC', number: '', name: 'Spirit Token', token: true,
      power: '9', toughness: '9', colors: ['W'], imageNumber: 3 }, 1);
    await vi.advanceTimersByTimeAsync(5000);
    const q = decodeURIComponent(f.calls.at(-1) ?? '');
    expect(resolver.store.getState().images['nec/spirit token#3']?.status).toBe('ok');
    expect(q).not.toContain('pow=');
  });

  it('a fresh resolver serves from the persisted cache without fetching', async () => {
    const f1 = fakeFetch();
    resolver = createScryfallResolver({ kv, fetchFn: f1.fn });
    resolver.resolve(card('KHM', '222', 'Lathril, Blade of the Elves'), 0);
    await vi.advanceTimersByTimeAsync(500);
    resolver.dispose();

    const f2 = fakeFetch();
    resolver = createScryfallResolver({ kv, fetchFn: f2.fn });
    resolver.resolve(card('KHM', '222', 'Lathril, Blade of the Elves'), 0);
    await vi.advanceTimersByTimeAsync(500);
    expect(f2.calls).toHaveLength(0);
    expect(resolver.store.getState().images['khm/222']?.status).toBe('ok');
  });
});
