// Command-builder tests: id policy (protocol §3) and optional-field omission.

import { describe, expect, it } from 'vitest';
import { encode } from '../src/protocol/codec';
import { defaultContext, hello, lobbyCreate, lobbyStart } from '../src/protocol/commands';

describe('command builders', () => {
  it('defaultContext mints ids unique across calls (no counters — §3 reconnect rule)', () => {
    const ctx = defaultContext();
    const ids = new Set(Array.from({ length: 100 }, () => ctx.mintId()));
    expect(ids.size).toBe(100);
  });

  it('omits absent optional fields entirely (no null/undefined keys on the wire)', () => {
    const ctx = { mintId: () => 'c1', now: () => 0 };
    expect(JSON.parse(encode(hello(ctx)))).toEqual({ t: 'session.hello', id: 'c1', v: 1 });
    expect(JSON.parse(encode(lobbyCreate(ctx)))).toEqual({ t: 'lobby.create', id: 'c1', format: 'commander-ffa' });
    expect(JSON.parse(encode(lobbyStart(ctx)))).toEqual({ t: 'lobby.start', id: 'c1' });
    expect(Object.hasOwn(hello(ctx), 'token')).toBe(false);
  });
});
