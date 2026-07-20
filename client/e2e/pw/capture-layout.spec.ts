// C5 layout-fixture capture (temporary — removed with the harness in Task 11).
// Drives a real game to a dense mid-game board and dumps the keyframe, so the
// CSS pass is tuned against real data rather than a guess.
//
// Requires XMage + bridge + `npm run dev`, exactly like autoplayer.spec.ts.

import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { driveGame } from './driver';

const DECK = fs.readFileSync(
  fileURLToPath(new URL('../../../upgrades_unleashed.dck', import.meta.url)), 'utf8');

const OUT = fileURLToPath(new URL('../artifacts/layout-keyframe.json', import.meta.url));
const TARGET_TURN = 25;             // turn 12 captured only 15 permanents and
                                    // empty graveyards (2026-07-19) — early AI
                                    // turns pass almost instantly, so aim later

test('capture a dense mid-game keyframe for the layout harness', async ({ page }) => {
  test.setTimeout(30 * 60_000);

  await page.goto('/');
  await expect(page.locator('.status')).toHaveText('connected');
  await page.getByPlaceholder('how the table sees you').fill('LayoutRicardo');
  await page.getByRole('button', { name: 'Create lobby' }).click();
  await expect(page.locator('.lobby-code .code')).toBeVisible();

  await page.locator('.deck-editor textarea').fill(DECK);
  await page.getByRole('button', { name: 'Submit deck' }).click();
  await expect(page.locator('.deck-ok')).toHaveCount(1, { timeout: 15_000 });
  await page.locator('.deck-controls input[type=checkbox]').click();
  await expect(page.locator('.seat-ready')).toHaveCount(1, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page.locator('.status-line')).toBeVisible({ timeout: 120_000 });

  const result = await driveGame(page, {
    label: 'capture',
    deadlineAt: Date.now() + 25 * 60_000,
    goalCombat: 1,
    stopWhen: snap => (snap.turn ?? 0) >= TARGET_TURN,
  });

  // A finished game is still a usable capture; an empty one is not.
  const state = await page.evaluate(() => window.__night?.dumpState() ?? null);
  expect(state, 'no game state to dump — did the game end before turn 25?').not.toBeNull();

  fs.mkdirSync(fileURLToPath(new URL('../artifacts', import.meta.url)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(state, null, 2));
  console.log(`[capture] wrote ${OUT} (turn ${result.final?.turn ?? '?'})`);
});
