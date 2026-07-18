// C2 exit criterion, headless half (design §14): one human seat driven by the
// autoplay policy through the full client protocol stack — socket FSM,
// dev-strict codec, route, stores, answer actions — against the real bridge +
// XMage with 3 AI opponents, all the way to game.over. The browser half (real
// DOM through the board and dock) is e2e/pw/two-browser.spec.ts; the full
// human-played game is the milestone's human step.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Recorder } from '../src/dev/recorder';
import { createActions } from '../src/net/actions';
import { createSocketManager } from '../src/net/socket';
import { createStores } from '../src/stores';
import { memoryKV } from '../src/stores/storage';
import { policyAnswer } from './autoplay';

const URL_UNDER_TEST = process.env['NIGHT_WS_URL'] ?? 'ws://localhost:5173/ws';
const GAME_TIMEOUT_MS = 900_000;   // AI-pace full Commander games run long

const DECK = fs.readFileSync(
  fileURLToPath(new URL('../../upgrades_unleashed.dck', import.meta.url)), 'utf8');

it('auto-played full game vs 3 AIs reaches game.over through the client stack', async () => {
  const kv = memoryKV();
  const stores = createStores(kv);
  const recorder = new Recorder({ capacity: 10_000 });
  const manager = createSocketManager({ stores, kv, recorder, url: URL_UNDER_TEST, strictDecode: true });
  const actions = createActions(stores, manager, kv);

  // the auto-player: answer every pending prompt by policy, escalating on
  // bounced answers, never re-firing while inflight
  const attempts = new Map<number, number>();
  let promptsAnswered = 0;
  const unsub = stores.prompt.subscribe(s => {
    const p = s.pending;
    if (p === undefined || s.inflight) return;
    const attempt = attempts.get(p.promptId) ?? 0;
    attempts.set(p.promptId, attempt + 1);
    const answer = policyAnswer(p, attempt);
    if (answer === null) return;   // give up loudly via the game timeout below
    promptsAnswered++;
    setTimeout(() => void actions.answerPrompt(p.promptId, answer), 5);
  });

  try {
    manager.connect();
    await expect.poll(() => stores.connection.getState().status, { timeout: 5000 }).toBe('ready');

    actions.setDisplayName('AutoRicardo');
    actions.setDeckText(DECK);
    await actions.createLobby();
    await actions.submitDeck();
    await expect.poll(
      () => stores.lobby.getState().state?.seats.find(s => s.name === 'AutoRicardo')?.deck,
      { timeout: 15_000 },
    ).toMatchObject({ valid: true });
    await actions.setReady(true);
    await actions.startGame(true);   // 3 AI opponents complete the pod

    await expect.poll(() => stores.game.getState().state !== undefined,
      { timeout: 120_000, interval: 500 }).toBe(true);
    expect(stores.game.getState().state!.players).toHaveLength(4);

    // …and now the whole game plays out
    try {
      await expect.poll(() => stores.game.getState().over !== undefined,
        { timeout: GAME_TIMEOUT_MS, interval: 1000 }).toBe(true);
    } catch (e) {
      const tail = recorder.entries().slice(-12);
      console.error(`--- pending prompt: ${JSON.stringify(stores.prompt.getState().pending)?.slice(0, 600)}`);
      console.error(`--- last ${tail.length} trace entries ---`);
      for (const entry of tail) console.error(entry.dir, JSON.stringify(entry.msg).slice(0, 400));
      throw e;
    }

    const over = stores.game.getState().over!;
    expect(over.reason).toBeTruthy();
    expect(stores.game.getState().state!.status).toBe('over');   // final keyframe preceded it
    expect(promptsAnswered).toBeGreaterThan(10);                 // the seat really played
    expect(stores.log.getState().entries.length).toBeGreaterThan(0);

    // dev-strict all the way: live traffic decoded without a single unknown field
    const decodeErrors = recorder.entries()
      .filter(e => typeof (e.msg as Record<string, unknown>)['decodeError'] === 'string');
    expect(decodeErrors).toEqual([]);

    // §7 discipline held for the whole game: no prompt ever needed >3 attempts
    const worst = Math.max(0, ...attempts.values());
    expect(worst).toBeLessThanOrEqual(3);
  } finally {
    unsub();
    manager.dispose();
  }
}, GAME_TIMEOUT_MS + 180_000);
