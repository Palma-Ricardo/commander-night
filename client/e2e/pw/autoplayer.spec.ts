// The C3 auto-player (design §13/§14): a full patch-mode game vs 3 AIs driven
// entirely through visible UI — the loop itself lives in driver.ts (shared
// with the C4 resilience spec). Asserts at game.over:
//   - ≥1 combat declaration went through the board (candidate → declared),
//   - zero unexpected resyncs and zero dev keyframe-verify divergences (§6),
//   - patches were really applied (patch mode, not keyframes),
//   - the no-dead-end-prompt invariant held: a rendered prompt always exposed
//     ≥1 enabled control, and no prompt sat unanswered for 60 s.

import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { driveGame, snapshot } from './driver';

const DECK = fs.readFileSync(
  fileURLToPath(new URL('../../../upgrades_unleashed.dck', import.meta.url)), 'utf8');

const GAME_MS = 45 * 60_000;        // AI-pace Commander games run long (§2),
                                    // and an active fourth seat prolongs them

test('auto-player: patch-mode game through the DOM to game.over with combat', async ({ page }) => {
  test.setTimeout(GAME_MS + 240_000);

  // ── lobby: create, deck, ready, start with AI fill ─────────────────────────
  await page.goto('/');
  await expect(page.locator('.status')).toHaveText('connected');
  await page.getByPlaceholder('how the table sees you').fill('AutoRicardo');
  await page.getByRole('button', { name: 'Create lobby' }).click();
  await expect(page.locator('.lobby-code .code')).toBeVisible();

  await page.locator('.deck-editor textarea').fill(DECK);
  await page.getByRole('button', { name: 'Submit deck' }).click();
  await expect(page.locator('.deck-ok')).toHaveCount(1, { timeout: 15_000 });
  await page.locator('.deck-controls input[type=checkbox]').click();
  await expect(page.locator('.seat-ready')).toHaveCount(1, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Start game' }).click();

  await expect(page.locator('.status-line')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('.seat-panel')).toHaveCount(4);

  // ── the auto-player loop (driver.ts) ───────────────────────────────────────
  const result = await driveGame(page, {
    label: 'auto',
    deadlineAt: Date.now() + GAME_MS,
    goalCombat: 1,
  });

  // ── C3 exit assertions ─────────────────────────────────────────────────────
  const final = (await snapshot(page))!;
  expect(result.over && final.over,
    `game did not finish (turn ${final.turn}, prompt ${final.promptKind})`).toBe(true);
  await expect(page.locator('.over-banner')).toBeVisible();

  expect(result.combatDeclarations, 'at least one combat declared through the board').toBeGreaterThanOrEqual(1);
  expect(final.counters.patches, 'patch mode really ran').toBeGreaterThan(50);
  expect(final.counters.verifies, 'the §6 backstop probe ran').toBeGreaterThanOrEqual(1);
  expect(final.counters.divergences).toBe(0);
  expect(final.counters.resyncs).toBe(0);
  expect(final.syncMode).toBe('live');
});
