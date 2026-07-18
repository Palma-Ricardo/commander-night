// C1 exit criterion, browser half (design §14): two browser contexts create/join
// a lobby on the real bridge, submit decks, host starts with AI fill; both land
// on the stub game screen with live keyframes rendering as raw state.

import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel: string) =>
  fs.readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');
const DECK_A = repoFile('upgrades_unleashed.dck');
const DECK_B = repoFile('bridge/decks/coverage_bgu.dck');

const SHOTS = process.env['NIGHT_SHOT_DIR'] ?? 'e2e/pw/artifacts';

test('two browsers: create/join → decks → fillAI start → stub game screen', async ({ browser }) => {
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
  // The ready checkbox renders from lobby.state (server echo), not from the
  // click — so click() + wait for the seat rows, never check() (which asserts
  // an immediate DOM flip that by design does not happen).
  await pageA.locator('.deck-controls input[type=checkbox]').click();
  await pageB.locator('.deck-controls input[type=checkbox]').click();
  await expect(pageA.locator('.seat-ready')).toHaveCount(2, { timeout: 10_000 });

  // host starts; "fill empty seats with AI" is checked by default
  await expect(pageA.locator('.host-controls')).toBeVisible();
  await pageA.getByRole('button', { name: 'Start game' }).click();

  // both land on the stub game screen with live keyframes as raw state
  await expect(pageA.locator('.status-line')).toBeVisible({ timeout: 120_000 });
  await expect(pageB.locator('.status-line')).toBeVisible({ timeout: 30_000 });
  await expect(pageA.locator('.raw-state pre')).toContainText('"players"');
  await expect(pageB.locator('.raw-state pre')).toContainText('"players"');
  await expect(pageA.locator('.status-line')).toContainText('Turn');

  fs.mkdirSync(SHOTS, { recursive: true });
  await pageA.screenshot({ path: `${SHOTS}/c1-host-game.png` });
  await pageB.screenshot({ path: `${SHOTS}/c1-guest-game.png` });
  await ctxA.close();
  await ctxB.close();
});
