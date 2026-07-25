// Two-browser smoke (design §14): two browser contexts create/join a lobby on
// the real bridge, submit decks, the host starts with AI fill; both land on a real
// four-seat board with a hand, and both answer their opening prompts (starting
// player, mulligan keeps, priority passes). Cheap and fast — the full two-browser
// resilience story is resilience.spec.ts, and a whole game is autoplayer.spec.ts.
//
// Client-agnostic since T5: the board is read through the harness (`seats`, the
// `scene()` actors) rather than through the classic client's DOM board, so this
// runs against the table client too.

import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { createLobby, joinViaLink, openHome, repoFile, startGame, submitDeckAndReady } from './chrome';
import { attachConsole, driveGame, waitForBoard } from './driver';
import { SHOTS } from './target';

const DECK_A = repoFile('bridge/src/test/resources/decks/upgrades_unleashed.dck');
const DECK_B = repoFile('bridge/decks/coverage_bgu.dck');

const OPENING_PROMPTS = 8;      // enough to cover the starting-player pick,
                                // both mulligan windows and a few passes

/** Hand cards the client is really rendering (§7.1): DOM cards in the classic
 *  client, canvas actors in the table client — one accessor covers both. */
async function handActors(page: Page): Promise<number> {
  return await page.evaluate(() =>
    (window.__night?.scene().actors ?? []).filter(a => a.zone === 'hand' && a.faceUp).length);
}

test('two browsers: lobby → four-seat board → opening prompts answered', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  attachConsole(pageA, '2B/A');
  attachConsole(pageB, '2B/B');

  await openHome(pageA, 'Ricardo');
  const code = await createLobby(pageA);
  // the guest lands via the invite deep link — the join form is prefilled
  await joinViaLink(pageB, code, 'Marta');
  await expect(pageA.locator('.seat')).toHaveCount(2);

  await submitDeckAndReady(pageA, DECK_A);
  await submitDeckAndReady(pageB, DECK_B);
  await expect(pageA.locator('.deck-ok')).toHaveCount(2, { timeout: 15_000 });
  await expect(pageA.locator('.seat-ready')).toHaveCount(2, { timeout: 10_000 });
  await startGame(pageA);

  await waitForBoard(pageA, 120_000);
  await waitForBoard(pageB, 30_000);

  // XMage asks mulligans sequentially and the ask order is toss-dependent, so
  // drive both seats concurrently and stop each once it has answered its share.
  const deadlineAt = Date.now() + 4 * 60_000;
  const stopWhen = (_s: unknown, p: { answered: number }) => p.answered >= OPENING_PROMPTS;
  const [a, b] = await Promise.all([
    driveGame(pageA, { label: '2B/A', deadlineAt, goalCombat: 0, stopWhen }),
    driveGame(pageB, { label: '2B/B', deadlineAt, goalCombat: 0, stopWhen }),
  ]);
  expect(a.answered, 'seat A answered its opening prompts').toBeGreaterThan(0);
  expect(b.answered, 'seat B answered its opening prompts').toBeGreaterThan(0);

  // the hand is really rendered (image or text frame — both are the real card UI)
  await expect.poll(() => handActors(pageA), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(() => handActors(pageB), { timeout: 30_000 }).toBeGreaterThan(0);

  fs.mkdirSync(SHOTS, { recursive: true });
  await pageA.screenshot({ path: `${SHOTS}/two-browser-host.png`, fullPage: true });
  await pageB.screenshot({ path: `${SHOTS}/two-browser-guest.png`, fullPage: true });
  await ctxA.close();
  await ctxB.close();
});
