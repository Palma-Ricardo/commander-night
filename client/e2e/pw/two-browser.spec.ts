// Browser-half live check (design §14 C1 flow + C2 board): two browser
// contexts create/join a lobby on the real bridge, submit decks, host starts
// with AI fill; both land on the real C2 board — 4 seat panels, hand cards,
// status line — and drive the prompt dock through visible UI (mulligan keep,
// priority passes). The full game to game.over runs in the headless live tier
// (e2e/game.live.test.ts); playing one by hand is the C2 exit's human step.

import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel: string) =>
  fs.readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');
const DECK_A = repoFile('upgrades_unleashed.dck');
const DECK_B = repoFile('bridge/decks/coverage_bgu.dck');

const SHOTS = process.env['NIGHT_SHOT_DIR'] ?? 'e2e/pw/artifacts';

/** Answer whatever the dock shows with its safe control, a bounded number of
 *  times: no (keep hand) → pass → done, else click the first highlighted board
 *  target (e.g. "Select a starting player" wants a seat-panel click). Returns
 *  how many clicks landed. */
async function answerDock(page: Page, rounds: number): Promise<number> {
  let clicks = 0;
  for (let i = 0; i < rounds; i++) {
    let clicked = false;
    for (const answer of ['no', 'pass', 'done'] as const) {
      const btn = page.locator(`.prompt-dock [data-answer=${answer}]:enabled`);
      if (await btn.count() > 0) {
        await btn.click({ timeout: 5000 }).catch(() => {});   // dock may supersede mid-click
        clicks++;
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      const target = page.locator('.hl-target').first();
      if (await target.count() > 0) {
        await target.click({ timeout: 5000 }).catch(() => {});
        clicks++;
      }
    }
    await page.waitForTimeout(700);
  }
  return clicks;
}

test('two browsers: lobby → C2 board → dock answers through visible UI', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // host creates
  await pageA.goto('/');
  await expect(pageA.locator('.status')).toHaveText('connected');
  await pageA.getByPlaceholder('how the table sees you').fill('Ricardo');
  await pageA.getByRole('button', { name: 'Create lobby' }).click();
  await expect(pageA.locator('.lobby-code .code')).toBeVisible();
  const code = (await pageA.locator('.lobby-code .code').textContent())!.trim();

  // guest lands via the invite deep link — the join form is prefilled
  await pageB.goto(`/#/join/${code}`);
  await pageB.getByPlaceholder('how the table sees you').fill('Marta');
  await expect(pageB.getByPlaceholder('XKCD42')).toHaveValue(code);
  await pageB.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(pageB.locator('.lobby-code .code')).toHaveText(code);
  await expect(pageA.locator('.seat')).toHaveCount(2);

  // decks + ready on both
  for (const [page, deck] of [[pageA, DECK_A], [pageB, DECK_B]] as const) {
    await page.locator('.deck-editor textarea').fill(deck);
    await page.getByRole('button', { name: 'Submit deck' }).click();
  }
  await expect(pageA.locator('.deck-ok')).toHaveCount(2, { timeout: 15_000 });
  // ready renders from the lobby.state echo, never from the click — click()
  // + wait, not check()
  await pageA.locator('.deck-controls input[type=checkbox]').click();
  await pageB.locator('.deck-controls input[type=checkbox]').click();
  await expect(pageA.locator('.seat-ready')).toHaveCount(2, { timeout: 10_000 });

  // host starts; "fill empty seats with AI" is checked by default
  await expect(pageA.locator('.host-controls')).toBeVisible();
  await pageA.getByRole('button', { name: 'Start game' }).click();

  // the C2 board: 4 seat panels (mine + 3 opponents), live status line
  await expect(pageA.locator('.status-line')).toBeVisible({ timeout: 120_000 });
  await expect(pageB.locator('.status-line')).toBeVisible({ timeout: 30_000 });
  await expect(pageA.locator('.seat-panel')).toHaveCount(4);
  await expect(pageB.locator('.seat-panel')).toHaveCount(4);

  // the dock appears (starting-player pick / mulligan ask) and answers land
  // through visible UI. XMage asks mulligans sequentially and the ask order is
  // toss-dependent, so wait for whichever seat is asked first and drive both
  // concurrently, as at a real table.
  await expect.poll(async () =>
    (await pageA.locator('.prompt-dock').count()) + (await pageB.locator('.prompt-dock').count()),
  { timeout: 60_000 }).toBeGreaterThan(0);
  const [clicksA, clicksB] = await Promise.all([answerDock(pageA, 16), answerDock(pageB, 16)]);
  expect(clicksA).toBeGreaterThan(0);
  expect(clicksB).toBeGreaterThan(0);

  // hands render as cards (image or text frame — both are the real C2 card UI)
  await expect(pageA.locator('.hand .card').first()).toBeVisible({ timeout: 30_000 });
  await expect(pageA.locator('.status-line')).not.toBeEmpty();

  fs.mkdirSync(SHOTS, { recursive: true });
  await pageA.screenshot({ path: `${SHOTS}/c2-host-board.png`, fullPage: true });
  await pageB.screenshot({ path: `${SHOTS}/c2-guest-board.png`, fullPage: true });
  await ctxA.close();
  await ctxB.close();
});
