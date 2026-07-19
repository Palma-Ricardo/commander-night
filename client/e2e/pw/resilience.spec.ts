// The C4 exit criterion (design §14): a two-browser Playwright game with
// mid-game reloads on both sides (same-promptId re-render asserted, protocol
// §14), chat both ways (echo-only rendering + unread badge), a live bumped
// round-trip (§10 single-session rule + "Use here"), recovery-join takeover
// from a cleared-storage context (protocol §5 name re-bind), and a rematch
// into a second completed game (§10 chat-convention flow). The client-side
// mirror of the bridge's MultiHumanLiveTest.

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { driveGame, snapshot } from './driver';

const repoFile = (rel: string) =>
  fs.readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');
const DECK_A = repoFile('upgrades_unleashed.dck');
const DECK_B = repoFile('bridge/decks/coverage_bgu.dck');

const SHOTS = process.env['NIGHT_SHOT_DIR'] ?? 'e2e/pw/artifacts';

const GAME_MS = 45 * 60_000;         // per game, AI pace (§2)
// Two coasting humans + 2 AIs race, and the finish is wildly variable: 8 min
// on one 2026-07-18 run, 3 min on the next. So the resilience phases are
// front-loaded and *sequenced on events*, never on a deadline that a fast
// game can beat (which is exactly how attempt 3 failed).
const RELOAD_A_MS = 30_000;
const RELOAD_B_MS = 45_000;
const TAKEOVER_AFTER_PROMPTS = 5;    // ...answered after B's reload completes

async function fillDeckAndReady(page: Page, deck: string): Promise<void> {
  await page.locator('.deck-editor textarea').fill(deck);
  await page.getByRole('button', { name: 'Submit deck' }).click();
  // own seat's verdict; the other seat's may land before/after — poll ready gate
  await expect(page.locator('.deck-controls input[type=checkbox]')).toBeEnabled({ timeout: 20_000 });
  await page.locator('.deck-controls input[type=checkbox]').click();
}

async function waitForBoard(page: Page, timeout: number): Promise<void> {
  await expect(page.locator('.status-line')).toBeVisible({ timeout });
  await expect(page.locator('.seat-panel')).toHaveCount(4);
}

async function sendChat(page: Page, text: string): Promise<void> {
  await page.locator('.chat-input input').fill(text);
  await page.locator('.chat-input input').press('Enter');
}

test('C4: reloads, chat, bumped, recovery join, rematch — two browsers to two game.overs', async ({ browser }) => {
  test.setTimeout(2 * GAME_MS + 20 * 60_000);
  fs.mkdirSync(SHOTS, { recursive: true });

  // ── lobby: host + guest via deep link, decks, ready, start with AI fill ────
  const ctxA = await browser.newContext();
  let ctxB: BrowserContext = await browser.newContext();
  const pageA = await ctxA.newPage();
  let pageB: Page = await ctxB.newPage();

  await pageA.goto('/');
  await expect(pageA.locator('.status')).toHaveText('connected');
  await pageA.getByPlaceholder('how the table sees you').fill('Ricardo');
  await pageA.getByRole('button', { name: 'Create lobby' }).click();
  await expect(pageA.locator('.lobby-code .code')).toBeVisible();
  const code = (await pageA.locator('.lobby-code .code').textContent())!.trim();

  await pageB.goto(`/#/join/${code}`);
  await pageB.getByPlaceholder('how the table sees you').fill('Marta');
  await expect(pageB.getByPlaceholder('XKCD42')).toHaveValue(code);
  await pageB.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(pageB.locator('.lobby-code .code')).toHaveText(code);

  await fillDeckAndReady(pageA, DECK_A);
  await fillDeckAndReady(pageB, DECK_B);
  await expect(pageA.locator('.seat-ready')).toHaveCount(2, { timeout: 15_000 });
  await expect(pageA.locator('.host-controls')).toBeVisible();
  await pageA.getByRole('button', { name: 'Start game' }).click();

  await waitForBoard(pageA, 120_000);
  await waitForBoard(pageB, 30_000);
  const gameId1 = (await snapshot(pageA))!.gameId;
  expect(gameId1).not.toBeNull();

  // ── chat both ways: echo-only rendering + unread badge (§8) ────────────────
  await sendChat(pageA, 'hello from A');
  // B sees the unread badge before opening the tab, then the line itself
  await expect(pageB.locator('.chat-unread')).toBeVisible({ timeout: 15_000 });
  await pageB.getByRole('button', { name: 'Chat' }).click();
  await expect(pageB.locator('.log-chat', { hasText: 'hello from A' })).toBeVisible();
  await expect(pageB.locator('.chat-unread')).toHaveCount(0);   // read
  await sendChat(pageB, 'hello from B');
  await pageA.getByRole('button', { name: 'Chat' }).click();
  await expect(pageA.locator('.log-chat', { hasText: 'hello from B' })).toBeVisible({ timeout: 15_000 });
  // the sender renders only the echo — its own line came back through game.log
  await expect(pageA.locator('.log-chat', { hasText: 'hello from A' })).toBeVisible();
  await pageA.screenshot({ path: `${SHOTS}/c4-chat.png`, fullPage: true });

  // ── bumped round-trip (§10): a second tab with the same storage takes the
  //    seat; "Use here" takes it back; no auto-bump loop ─────────────────────
  const pageA2 = await ctxA.newPage();
  await pageA2.goto('/');
  await expect(pageA.locator('.bumped-screen')).toBeVisible({ timeout: 30_000 });
  await waitForBoard(pageA2, 30_000);                    // the thief resumed mid-game
  await pageA.getByRole('button', { name: 'Use here' }).click();
  await waitForBoard(pageA, 30_000);
  await expect(pageA2.locator('.bumped-screen')).toBeVisible({ timeout: 30_000 });
  await pageA.screenshot({ path: `${SHOTS}/c4-bumped-recovered.png`, fullPage: true });
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
  expect(resultB1.reloaded, 'B reloaded mid-game before the takeover').toBe(true);
  // Mid-game is the interesting case (the seat is live and a prompt is
  // pending); if the AIs ended game 1 first the takeover still exercises the
  // §5 name re-bind and the §14 resume, just landing on the final keyframe +
  // game.over instead of a prompt. Both are asserted, neither is skipped.
  const tookOverMidGame = resultB1.stopped;
  const promptBefore = resultB1.final!.promptId;
  await ctxB.close();                                    // the dead browser

  const ctxB2 = await browser.newContext();              // cleared storage
  const newPageB = await ctxB2.newPage();
  await newPageB.goto(`/#/join/${code}`);
  await newPageB.getByPlaceholder('how the table sees you').fill('Marta');
  await newPageB.getByRole('button', { name: 'Join', exact: true }).click();
  await waitForBoard(newPageB, 60_000);
  if (tookOverMidGame) {
    // §14: the re-emitted prompt keeps its promptId across the takeover
    await expect.poll(async () => (await snapshot(newPageB))?.promptId ?? null,
      { timeout: 30_000 }).toBe(promptBefore);
  } else {
    console.log('[C4] game 1 ended before the takeover — asserting post-game resume instead');
    await expect(newPageB.locator('.over-banner')).toBeVisible({ timeout: 30_000 });
  }
  await newPageB.screenshot({ path: `${SHOTS}/c4-recovery-join.png`, fullPage: true });
  ctxB = ctxB2;
  pageB = newPageB;

  const resultB2 = await driveGame(pageB, {
    label: 'B2', deadlineAt: t0 + GAME_MS, goalCombat: 0,
  });
  expect(resultB2.over, 'game 1 finished on the recovered seat').toBe(true);

  const resultA = await driverA;
  expect(resultA.over, 'game 1 finished on seat A').toBe(true);
  expect(resultA.reloaded, 'A reloaded mid-game').toBe(true);
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
  await fillDeckAndReady(pageB, DECK_B);
  await pageA.locator('.deck-controls input[type=checkbox]').click();
  await expect(pageA.locator('.seat-ready')).toHaveCount(2, { timeout: 15_000 });
  await pageA.getByRole('button', { name: 'Start game' }).click();

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

  await pageA.screenshot({ path: `${SHOTS}/c4-game2-over-host.png`, fullPage: true });
  await pageB.screenshot({ path: `${SHOTS}/c4-game2-over-guest.png`, fullPage: true });
  await ctxA.close();
  await ctxB.close();
});
