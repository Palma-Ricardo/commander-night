// Scryfall resolver (design §9/§13): queue pacing (~8 req/s), visibility
// priority ordering, dedupe, the lookup ladder (byId → byName for real cards;
// t-set → set → any printing for tokens), miss list, and the localStorage
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

  it('tokens look up the bare name in the t-prefixed set (live-verified shape)', async () => {
    const f = fakeFetch();
    resolver = createScryfallResolver({ kv, fetchFn: f.fn, minIntervalMs: 125 });
    resolver.resolve({ set: 'WAR', number: '', name: 'Goblin Token', token: true }, 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toEqual(['https://api.scryfall.com/cards/named?exact=Goblin&set=twar']);
    expect(resolver.store.getState().images['war/goblin token']?.status).toBe('ok');
  });

  it('token ladder falls through t-set → printed set → any printing', async () => {
    const f = fakeFetch(url => url.includes('set='));   // both set-scoped lookups 404
    resolver = createScryfallResolver({ kv, fetchFn: f.fn, minIntervalMs: 125 });
    resolver.resolve({ set: 'NPH', number: '', name: 'Beast Token', token: true }, 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.calls).toEqual([
      'https://api.scryfall.com/cards/named?exact=Beast&set=tnph',
      'https://api.scryfall.com/cards/named?exact=Beast&set=nph',
      'https://api.scryfall.com/cards/named?exact=Beast',
    ]);
    expect(resolver.store.getState().images['nph/beast token']?.status).toBe('ok');
  });

  it('two tokens from one set do not collide on the empty collector number', async () => {
    const f = fakeFetch();
    resolver = createScryfallResolver({ kv, fetchFn: f.fn, minIntervalMs: 125 });
    resolver.resolve({ set: 'WAR', number: '', name: 'Goblin Token', token: true }, 1);
    resolver.resolve({ set: 'WAR', number: '', name: 'Zombie Army Token', token: true }, 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.calls).toHaveLength(2);
    expect(resolver.store.getState().images['war/goblin token']?.status).toBe('ok');
    expect(resolver.store.getState().images['war/zombie army token']?.status).toBe('ok');
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
