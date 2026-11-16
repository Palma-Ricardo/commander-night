// The resilience exit criterion (design §14; T5 for the table client): a
// two-browser Playwright game with mid-game reloads on both sides (same-promptId
// re-render asserted, protocol §14), chat both ways (echo-only rendering + unread
// badge), a live bumped round-trip (§10 single-session rule + "Use here"),
// recovery-join takeover from a cleared-storage context (protocol §5 name
// re-bind), and a rematch into a second completed game (§10 chat-convention
// flow). The client-side mirror of the bridge's MultiHumanLiveTest.
//
// Client-agnostic (T5): the board is driven through the semantic harness and the
// chrome through the DOM both clients share, so this is the table client's
// resilience proof as much as the classic client's.

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import {
  createLobby, joinViaLink, openChat, openHome, repoFile, sendChat, startGame, submitDeckAndReady,
} from './chrome';
import { coverageGoal } from './coverage';
import { attachConsole, driveGame, snapshot, waitForBoard } from './driver';
import { SHOTS } from './target';

const DECK_A = repoFile('bridge/src/test/resources/decks/upgrades_unleashed.dck');
const DECK_B = repoFile('bridge/decks/coverage_bgu.dck');

const GAME_MS = 45 * 60_000;         // per game, AI pace (§2)
// Two coasting humans + 2 AIs race, and the finish is wildly variable: 8 min
// on one 2026-07-18 run, 3 min on the next. So the resilience phases are
// front-loaded and *sequenced on events*, never on a deadline that a fast
// game can beat (which is exactly how attempt 3 failed).
const RELOAD_A_MS = 30_000;
const RELOAD_B_MS = 45_000;
const TAKEOVER_AFTER_PROMPTS = 5;    // ...answered after B's reload completes

test('reloads, chat, bumped, recovery join, rematch — two browsers to two game.overs', async ({ browser }) => {
  test.setTimeout(2 * GAME_MS + 20 * 60_000);
  fs.mkdirSync(SHOTS, { recursive: true });

  // ── lobby: host + guest via deep link, decks, ready, start with AI fill ────
  const ctxA = await browser.newContext();
  let ctxB: BrowserContext = await browser.newContext();
  const pageA = await ctxA.newPage();
  let pageB: Page = await ctxB.newPage();
  attachConsole(pageA, 'A');
  attachConsole(pageB, 'B');

  await openHome(pageA, 'Ricardo');
  const code = await createLobby(pageA);
  await joinViaLink(pageB, code, 'Marta');

  await submitDeckAndReady(pageA, DECK_A);
  await submitDeckAndReady(pageB, DECK_B);
  await expect(pageA.locator('.seat-ready')).toHaveCount(2, { timeout: 15_000 });
  await startGame(pageA);

  await waitForBoard(pageA, 120_000);
  await waitForBoard(pageB, 30_000);
  const gameId1 = (await snapshot(pageA))!.gameId;
  expect(gameId1).not.toBeNull();

  // ── chat both ways: echo-only rendering + unread badge (§8) ────────────────
  await sendChat(pageA, 'hello from A');
  // B sees the unread badge before opening the tab, then the line itself
  await expect(pageB.locator('.chat-unread')).toBeVisible({ timeout: 15_000 });
  await openChat(pageB);
  await expect(pageB.locator('.log-chat', { hasText: 'hello from A' })).toBeVisible();
  await expect(pageB.locator('.chat-unread')).toHaveCount(0);   // read
  await sendChat(pageB, 'hello from B');
  await openChat(pageA);
  await expect(pageA.locator('.log-chat', { hasText: 'hello from B' })).toBeVisible({ timeout: 15_000 });
  // the sender renders only the echo — its own line came back through game.log
  await expect(pageA.locator('.log-chat', { hasText: 'hello from A' })).toBeVisible();
  await pageA.screenshot({ path: `${SHOTS}/chat.png`, fullPage: true });

  // ── bumped round-trip (§10): a second tab with the same storage takes the
  //    seat; "Use here" takes it back; no auto-bump loop ─────────────────────
  const pageA2 = await ctxA.newPage();
  attachConsole(pageA2, 'A2');
  await pageA2.goto('/');
  await expect(pageA.locator('.bumped-screen')).toBeVisible({ timeout: 30_000 });
  await waitForBoard(pageA2, 30_000);                    // the thief resumed mid-game
  await pageA.getByRole('button', { name: 'Use here' }).click();
  await waitForBoard(pageA, 30_000);
  await expect(pageA2.locator('.bumped-screen')).toBeVisible({ timeout: 30_000 });
  await pageA.screenshot({ path: `${SHOTS}/bumped-recovered.png`, fullPage: true });
  await pageA2.close();

  // ── game 1: drive both; each side reloads once mid-game (same-promptId
  //    asserted inside the driver); B stops at the takeover point ────────────
  const t0 = Date.now();
  let promptsAtReload: number | null = null;
  const driverA = driveGame(pageA, {
    label: 'A', deadlineAt: t0 + GAME_MS, goalCombat: 1, reloadAfterMs: RELOAD_A_MS,
  });
  const resultB1 = await driveGame(pageB, {
    label: 'B', deadlineAt: t0 + GAME_MS, goalCombat: 0, reloadAfterMs: RELOAD_B_MS,
    stopWhen: (snap, p) => {
      if (!p.reloaded) return false;
      promptsAtReload ??= p.answered;
      return p.answered - promptsAtReload >= TAKEOVER_AFTER_PROMPTS
        && snap.promptId !== null && !snap.inflight;
    },
  });

  // ── recovery join (protocol §5/§14): B's browser "ate localStorage" — a
  //    cleared-storage context takes the seat back by name and lands on the
  //    exact same pending prompt ──────────────────────────────────────────────
  // The reloads are scheduled by time, so a game that ends early skips them (chance).
  coverageGoal('B reloaded mid-game before the takeover', resultB1.reloaded,
    !resultB1.reloaded ? 'game 1 ended before the reload'
      : resultB1.stopped ? 'took over mid-game' : 'game 1 ended after the reload');
  // Mid-game is the interesting case (the seat is live and a prompt is
  // pending); if the AIs ended game 1 first the takeover still exercises the
  // §5 name re-bind and the §14 resume, just landing on the final keyframe +
  // game.over instead of a prompt. Both are asserted, neither is skipped.
  const tookOverMidGame = resultB1.stopped;
  const promptBefore = resultB1.final!.promptId;
  await ctxB.close();                                    // the dead browser

  const ctxB2 = await browser.newContext();              // cleared storage
  const newPageB = await ctxB2.newPage();
  attachConsole(newPageB, 'B2');
  await joinViaLink(newPageB, code, 'Marta', { expectLobby: false });
  await waitForBoard(newPageB, 60_000);
  if (tookOverMidGame) {
    // §14: the re-emitted prompt keeps its promptId across the takeover
    await expect.poll(async () => (await snapshot(newPageB))?.promptId ?? null,
      { timeout: 30_000 }).toBe(promptBefore);
  } else {
    console.log('[resilience] game 1 ended before the takeover — asserting post-game resume instead');
    await expect(newPageB.locator('.over-banner')).toBeVisible({ timeout: 30_000 });
  }
  await newPageB.screenshot({ path: `${SHOTS}/recovery-join.png`, fullPage: true });
  ctxB = ctxB2;
  pageB = newPageB;

  const resultB2 = await driveGame(pageB, {
    label: 'B2', deadlineAt: t0 + GAME_MS, goalCombat: 0,
  });
  expect(resultB2.over, 'game 1 finished on the recovered seat').toBe(true);

  const resultA = await driverA;
  expect(resultA.over, 'game 1 finished on seat A').toBe(true);
  coverageGoal('A reloaded mid-game', resultA.reloaded, `reload scheduled at ${RELOAD_A_MS / 1000} s`);
  await expect(pageA.locator('.over-banner')).toBeVisible();
  await expect(pageB.locator('.over-banner')).toBeVisible({ timeout: 30_000 });

  // ── rematch (§10): the host creates the fresh lobby and announces the code;
  //    the guest joins from the banner. The chat announce is best-effort —
  //    XMage 1.4.60 delivers no CHATMESSAGE after GAME_OVER (probed live
  //    2026-07-18), so the guest types the code the host read out, which is
  //    also the path a real table uses. The field prefills from chat if the
  //    invite ever does arrive. ────────────────────────────────────────────────
  await pageA.getByRole('button', { name: 'Rematch', exact: true }).click();
  await expect(pageA.locator('.lobby-code .code')).toBeVisible({ timeout: 15_000 });
  const code2 = (await pageA.locator('.lobby-code .code').textContent())!.trim();
  expect(code2).not.toBe(code);
  // host's persisted deck was auto-resubmitted by the rematch action
  await expect(pageA.locator('.deck-ok')).toHaveCount(1, { timeout: 20_000 });

  await pageB.locator('.over-banner .rematch-code').fill(code2);
  await pageB.getByRole('button', { name: 'Join rematch' }).click();
  await expect(pageB.locator('.lobby-code .code')).toHaveText(code2, { timeout: 15_000 });
  // B's context was minted at the recovery join — no persisted deck to resubmit
  await submitDeckAndReady(pageB, DECK_B);
  await pageA.locator('.deck-controls input[type=checkbox]').click();
  await expect(pageA.locator('.seat-ready')).toHaveCount(2, { timeout: 15_000 });
  await startGame(pageA);

  // ── game 2: a genuinely different game, driven to its own game.over ────────
  await waitForBoard(pageA, 120_000);
  await waitForBoard(pageB, 30_000);
  const gameId2 = (await snapshot(pageA))!.gameId;
  expect(gameId2).not.toBeNull();
  expect(gameId2).not.toBe(gameId1);

  const t2 = Date.now();
  const [a2, b2] = await Promise.all([
    driveGame(pageA, { label: 'A/g2', deadlineAt: t2 + GAME_MS, goalCombat: 0 }),
    driveGame(pageB, { label: 'B/g2', deadlineAt: t2 + GAME_MS, goalCombat: 0 }),
  ]);
  expect(a2.over, 'game 2 finished on seat A').toBe(true);
  expect(b2.over, 'game 2 finished on seat B').toBe(true);
  await expect(pageA.locator('.over-banner')).toBeVisible();
  await expect(pageB.locator('.over-banner')).toBeVisible({ timeout: 30_000 });

  await pageA.screenshot({ path: `${SHOTS}/game2-over-host.png`, fullPage: true });
  await pageB.screenshot({ path: `${SHOTS}/game2-over-guest.png`, fullPage: true });
  await ctxA.close();
  await ctxB.close();
});
