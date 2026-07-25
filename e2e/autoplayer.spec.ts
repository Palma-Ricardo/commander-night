// The auto-player (design §12/§13): a full patch-mode game vs 3 AIs, lobby to
// game.over, driven through the client's own chrome and the semantic harness —
// the loop itself lives in driver.ts (shared with the resilience spec). Runs
// against either client by baseURL (T5). Asserts at game.over:
//   - ≥1 combat declaration went through the board (candidate → declared),
//   - zero unexpected resyncs and zero dev keyframe-verify divergences (§6),
//   - patches were really applied (patch mode, not keyframes),
//   - the no-dead-end-prompt invariant held: a rendered prompt always exposed
//     ≥1 enabled control, and no prompt sat unanswered for 60 s.

import { expect, test } from '@playwright/test';
import { createLobby, openHome, repoFile, startGame, submitDeckAndReady } from './chrome';
import { attachConsole, driveGame, snapshot, waitForBoard } from './driver';

const DECK = repoFile('bridge/src/test/resources/decks/upgrades_unleashed.dck');

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

  expect(result.combatDeclarations, 'at least one combat declared through the board').toBeGreaterThanOrEqual(1);
  expect(final.counters.patches, 'patch mode really ran').toBeGreaterThan(50);
  // The §6 probe deep-equals a backstop keyframe against the locally-patched tree.
  // It only fires when that keyframe lands at exactly lastAppliedSeq+1 — other
  // event kinds share the seq counter (protocol §3), so a log line landing between
  // the patch and its backstop silently skips one. Report the whole counter set
  // when it fails: "verifies: 0" alone cannot distinguish "no backstop arrived"
  // from "every backstop was interleaved".
  expect(final.counters.verifies,
    `the §6 backstop probe ran — counters: ${JSON.stringify(final.counters)}`).toBeGreaterThanOrEqual(1);
  expect(final.counters.divergences).toBe(0);
  expect(final.counters.resyncs).toBe(0);
  expect(final.syncMode).toBe('live');
});
