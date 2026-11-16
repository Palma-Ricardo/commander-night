// The auto-player (design §12/§13): a full patch-mode game vs 3 AIs, lobby to
// game.over, driven through the client's own chrome and the semantic harness —
// the loop itself lives in driver.ts (shared with the resilience spec). Runs
// against either client by baseURL (T5). Asserts at game.over:
//   - zero unexpected resyncs and zero dev keyframe-verify divergences (§6),
//   - patches were really applied (patch mode, not keyframes),
//   - the no-dead-end-prompt invariant held: a rendered prompt always exposed
//     ≥1 enabled control, and no prompt sat unanswered for 60 s.
// Reports as coverage goals (coverage.ts; they depend on the shuffle): a combat
// declaration through the board, a real game's worth of patches, the §6 probe.

import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { createLobby, openHome, repoFile, startGame, submitDeckAndReady } from './chrome';
import { coverageGoal } from './coverage';
import { attachConsole, driveGame, snapshot, waitForBoard } from './driver';

// NIGHT_DECK: absolute path to a .dck to play instead of the default fixture.
const DECK = process.env.NIGHT_DECK
  ? fs.readFileSync(process.env.NIGHT_DECK, 'utf8')
  : repoFile('bridge/src/test/resources/decks/upgrades_unleashed.dck');

const GAME_MS = 45 * 60_000;        // AI-pace Commander games run long (§2),
                                    // and an active fourth seat prolongs them

test('auto-player: patch-mode game to game.over with combat', async ({ page }) => {
  test.setTimeout(GAME_MS + 240_000);

  // ── lobby: create, deck, ready, start with AI fill ─────────────────────────
  attachConsole(page, 'auto');
  await openHome(page, 'AutoRicardo');
  await createLobby(page);
  await submitDeckAndReady(page, DECK);
  await expect(page.locator('.seat-ready')).toHaveCount(1, { timeout: 10_000 });
  await startGame(page);
  await waitForBoard(page, 120_000);

  // ── the auto-player loop (driver.ts) ───────────────────────────────────────
  const result = await driveGame(page, {
    label: 'auto',
    deadlineAt: Date.now() + GAME_MS,
    goalCombat: 1,
  });

  // ── exit assertions ────────────────────────────────────────────────────────
  const final = (await snapshot(page))!;
  expect(result.over && final.over,
    `game did not finish (turn ${final.turn}, prompt ${final.promptKind})`).toBe(true);
  await expect(page.locator('.over-banner')).toBeVisible();

  expect(final.counters.patches, 'patch mode really ran').toBeGreaterThan(0);
  coverageGoal('combat declared through the board (candidate → declared)',
    result.combatDeclarations >= 1, `${result.combatDeclarations} declarations`);
  coverageGoal("a real game's worth of patches (>50)", final.counters.patches > 50,
    `${final.counters.patches} patches`);
  // The §6 probe deep-equals a backstop keyframe against the locally-patched tree.
  // It only fires when that keyframe lands at exactly lastAppliedSeq+1 — other
  // event kinds share the seq counter (protocol §3), so a log line landing between
  // the patch and its backstop silently skips one, so whether it runs is chance.
  // Report the whole counter set: "verifies: 0" alone cannot distinguish "no
  // backstop arrived" from "every backstop was interleaved".
  coverageGoal('the §6 backstop probe ran', final.counters.verifies >= 1,
    `counters: ${JSON.stringify(final.counters)}`);
  expect(final.counters.divergences).toBe(0);
  expect(final.counters.resyncs).toBe(0);
  expect(final.syncMode).toBe('live');
});
