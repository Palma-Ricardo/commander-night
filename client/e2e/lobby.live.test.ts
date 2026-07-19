// C1 live check (design §14 C1 exit, headless half): two full client stacks —
// stores, socket FSM, actions, dev-strict codec — through the real bridge and
// XMage: create/join a lobby, submit decks, ready up, host starts with AI fill,
// both seats receive live keyframes. The browser half is the Playwright spec
// (e2e/pw/), which drives the same flow through the real UI.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Recorder } from '../src/dev/recorder';
import { createActions } from '../src/net/actions';
import { createSocketManager } from '../src/net/socket';
import { createStores } from '../src/stores';
import { memoryKV } from '../src/stores/storage';

const URL_UNDER_TEST = process.env['NIGHT_WS_URL'] ?? 'ws://localhost:5173/ws';

const repoFile = (rel: string) =>
  fs.readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const DECK_A = repoFile('upgrades_unleashed.dck');
const DECK_B = repoFile('bridge/decks/coverage_bgu.dck');

function makeClient() {
  const kv = memoryKV();
  const stores = createStores(kv);
  const recorder = new Recorder();
  const manager = createSocketManager({ stores, kv, recorder, url: URL_UNDER_TEST, strictDecode: true, devVerify: true });
  const actions = createActions(stores, manager, kv);
  return { kv, stores, recorder, manager, actions };
}

type Client = ReturnType<typeof makeClient>;

const seatOf = (c: Client, name: string) =>
  c.stores.lobby.getState().state?.seats.find(s => s.name === name);

it('two clients: lobby → decks → fillAI start → live keyframes on both seats', async () => {
  const a = makeClient();
  const b = makeClient();
  try {
    a.manager.connect();
    b.manager.connect();
    await expect.poll(() => a.stores.connection.getState().status, { timeout: 5000 }).toBe('ready');
    await expect.poll(() => b.stores.connection.getState().status, { timeout: 5000 }).toBe('ready');

    a.actions.setDisplayName('Ricardo');
    b.actions.setDisplayName('Marta');

    const code = await a.actions.createLobby();
    expect(code).toMatch(/^[A-Z0-9]+$/);
    await b.actions.joinLobby(code);
    await expect.poll(() => a.stores.lobby.getState().state?.seats.length).toBe(2);

    a.actions.setDeckText(DECK_A);
    b.actions.setDeckText(DECK_B);
    await a.actions.submitDeck();
    await b.actions.submitDeck();

    // parse verdicts arrive on the lobby.state broadcast (§5)
    await expect.poll(() => seatOf(a, 'Ricardo')?.deck, { timeout: 15000 }).toMatchObject({ valid: true });
    await expect.poll(() => seatOf(a, 'Marta')?.deck, { timeout: 15000 }).toMatchObject({ valid: true });

    await a.actions.setReady(true);
    await b.actions.setReady(true);
    await a.actions.startGame(true);   // fillAI: two server AIs complete the pod

    // XMage table create/join/start → GAME_INIT → keyframe seq 0 on both seats
    try {
      await expect.poll(() => a.stores.game.getState().state !== undefined,
        { timeout: 120_000, interval: 500 }).toBe(true);
      await expect.poll(() => b.stores.game.getState().state !== undefined,
        { timeout: 30_000, interval: 500 }).toBe(true);
    } catch (e) {
      for (const [label, c] of [['A', a], ['B', b]] as const) {
        const tail = c.stores === undefined ? [] : c.recorder.entries().slice(-8);
        console.error(`--- client ${label} last ${tail.length} trace entries ---`);
        for (const entry of tail) {
          console.error(entry.dir, JSON.stringify(entry.msg).slice(0, 600));
        }
      }
      throw e;
    }

    const sa = a.stores.game.getState().state!;
    const sb = b.stores.game.getState().state!;
    expect(sa.players).toHaveLength(4);
    expect(sb.players).toHaveLength(4);
    expect(sa.me.playerId).not.toBe(sb.me.playerId);
    const nameOf = (s: typeof sa, id: string) => s.players.find(p => p.id === id)?.name;
    expect(nameOf(sa, sa.me.playerId)).toBe('Ricardo');
    expect(nameOf(sb, sb.me.playerId)).toBe('Marta');

    // the game is live: activity (AI mulligans / our first ask) reaches each seat
    // as fresh keyframes (keyframes mode) or a pending prompt
    for (const c of [a, b]) {
      await expect.poll(
        () => c.stores.game.getState().lastAppliedSeq > 0 || c.stores.prompt.getState().pending !== undefined,
        { timeout: 60_000, interval: 500 },
      ).toBe(true);
    }

    // dev-strict all the way: any unknown/malformed field in live traffic would
    // have been recorded as a decode error
    const decodeErrors = [...a.recorder.entries(), ...b.recorder.entries()]
      .filter(e => typeof (e.msg as Record<string, unknown>)['decodeError'] === 'string');
    expect(decodeErrors).toEqual([]);
  } finally {
    a.manager.dispose();
    b.manager.dispose();
  }
}, 240_000);
