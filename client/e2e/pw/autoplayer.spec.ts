// The C3 auto-player (design §13/§14): a full patch-mode game vs 3 AIs driven
// entirely through visible UI — the bridge live tier's policy (play lands,
// cast each castable once with payMana-cancel bounded, attack with one
// creature, first-legal dialog answers) as DOM clicks. Asserts at game.over:
//   - ≥1 combat declaration went through the board (candidate → declared),
//   - zero unexpected resyncs and zero dev keyframe-verify divergences (§6),
//   - patches were really applied (patch mode, not keyframes),
//   - the no-dead-end-prompt invariant held: a rendered prompt always exposed
//     ≥1 enabled control, and no prompt sat unanswered for 60 s.

import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NightSnapshot } from '../../src/app';

const DECK = fs.readFileSync(
  fileURLToPath(new URL('../../../upgrades_unleashed.dck', import.meta.url)), 'utf8');

const GAME_MS = 45 * 60_000;        // AI-pace Commander games run long (§2),
                                    // and an active fourth seat prolongs them
const STUCK_MS = 60_000;            // same prompt, no progress → dead end
const TICK_MS = 200;

const snapshot = (page: Page): Promise<NightSnapshot | null> =>
  page.evaluate(() => window.__night?.snapshot() ?? null);

/** One enabled affordance somewhere: a dock/modal/popover button or a
 *  highlighted board object (§13 UI-completeness invariant). */
async function enabledControls(page: Page): Promise<number> {
  return await page.locator(
    [
      '.prompt-dock button:enabled',
      '.modal button:enabled',
      '.ability-popover button:enabled',
      '.card-menu button:enabled',
      '.hl-action', '.hl-target', '.hl-combat', '.hl-declared', '.hl-source',
    ].join(', '),
  ).count();
}

async function clickFirst(page: Page, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count() > 0) {
      // prompts supersede mid-click all the time — a missed click is not an error
      await loc.click({ timeout: 3000, force: true }).catch(() => {});
      return sel;
    }
  }
  return null;
}

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

  // ── the auto-player loop ───────────────────────────────────────────────────
  let combatDeclarations = 0;
  let combatToggleClicked = false;   // set when we click a candidate; a later
                                     // declared>0 observation = our declaration
  const actionTried = new Set<string>();
  let lastPromptId: number | null = null;
  let lastProgressAt = Date.now();
  let lastHeartbeatAt = 0;
  const deadline = Date.now() + GAME_MS;

  while (Date.now() < deadline) {
    const snap = await snapshot(page);
    if (snap === null) throw new Error('window.__night missing — not a dev build?');
    if (snap.over) break;

    // sync discipline must hold the whole game (§6)
    expect(snap.counters.resyncs, 'unexpected resync mid-game').toBe(0);
    expect(snap.counters.divergences, 'keyframe-verify divergence').toBe(0);

    if (Date.now() - lastHeartbeatAt > 60_000) {
      lastHeartbeatAt = Date.now();
      console.log(`[auto] turn ${snap.turn} · patches ${snap.counters.patches} · verifies ${snap.counters.verifies} · combat ${combatDeclarations} · prompt ${snap.promptKind}`);
    }

    if (snap.promptId === null || snap.inflight) {
      await page.waitForTimeout(TICK_MS);
      continue;
    }

    // stuck/dead-end tracking, per §13: 60 s on one prompt = fail
    if (snap.promptId !== lastPromptId) {
      lastPromptId = snap.promptId;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > STUCK_MS) {
      throw new Error(`stuck ≥${STUCK_MS / 1000}s on prompt ${snap.promptId} (${snap.promptKind})`);
    }

    const dock = page.locator('.prompt-dock');
    if (await dock.count() === 0) {
      await page.waitForTimeout(TICK_MS);
      continue;
    }

    // the no-dead-end invariant: a rendered prompt exposes ≥1 enabled control
    if (!(await dock.getAttribute('class'))?.includes('dock-busy')) {
      expect(await enabledControls(page),
        `dead-end prompt ${snap.promptId} (${snap.promptKind})`).toBeGreaterThan(0);
    }

    switch (snap.promptKind) {
      case 'confirm': {
        // default No (keep hands, decline extras) — but the mana-burn ask
        // ("mana in your pool will be lost. Pass anyway?") must be Yes, or
        // No → priority → pass → same ask loops for the rest of the step
        const msg = (await page.locator('.prompt-dock .dock-msg').textContent().catch(() => '')) ?? '';
        const yes = /pass anyway|will be lost/i.test(msg);
        await clickFirst(page, [`.prompt-dock [data-answer=${yes ? 'yes' : 'no'}]:enabled`]);
        break;
      }

      case 'priority': {
        if (snap.combatRole !== null) {
          const declared = await page.locator('.hl-declared').count();
          const candidates = await page.locator('.hl-combat').count();
          if (declared > 0) {
            // our toggle went through the board: candidate → declared (§8)
            if (combatToggleClicked) {
              combatDeclarations++;
              combatToggleClicked = false;
            }
            await clickFirst(page, ['.prompt-dock [data-answer=done]:enabled']);
          } else if (snap.combatRole === 'attackers' && candidates > 0 && combatDeclarations === 0) {
            // attack with one creature until one declaration is banked (§13)
            combatToggleClicked = true;
            await page.locator('.hl-combat').first().click({ timeout: 3000, force: true }).catch(() => {});
            await page.waitForTimeout(500);   // one toggle = one round trip (§8)
          } else {
            // blockers: never block; post-goal or nothing eligible: done
            await clickFirst(page, ['.prompt-dock [data-answer=done]:enabled']);
          }
          break;
        }
        // until the combat goal is banked: play lands / cast castables
        // (retried per turn — a cast that fizzled on mana early can succeed
        // later). Afterwards coast — a passive seat lets the AIs end the game.
        if (combatDeclarations > 0) {
          await clickFirst(page, ['.prompt-dock [data-answer=pass]:enabled']);
          break;
        }
        const actions = page.locator('.hl-action');
        let clicked = false;
        for (let i = 0; i < await actions.count(); i++) {
          const el = actions.nth(i);
          const id = await el.getAttribute('data-card-id');
          const key = `${snap.turn}:${id}`;
          if (id === null || actionTried.has(key)) continue;
          actionTried.add(key);
          await el.click({ timeout: 3000, force: true }).catch(() => {});
          await page.waitForTimeout(150);
          await clickFirst(page, ['.card-menu button:enabled']);   // multi-action popover
          clicked = true;
          break;
        }
        if (!clicked) await clickFirst(page, ['.prompt-dock [data-answer=pass]:enabled']);
        break;
      }

      case 'chooseTargets': {
        const done = await clickFirst(page, [
          '.prompt-dock [data-answer=decline]:enabled',
          '.modal [data-answer=decline]:enabled',
          '.prompt-dock [data-answer=submit]:enabled',
          '.modal [data-answer=submit]:enabled',
        ]);
        if (done === null) {
          // accumulate one more — never re-click a selected card (that toggles it out)
          await clickFirst(page, ['.modal .card:not(.card-selected)', '.hl-target:not(.card-selected)']);
        }
        break;
      }

      case 'payMana':
        // PAY first — floating pool mana, then sources; cancel only when
        // nothing can pay (cancel-first killed every cast and left the
        // auto-tapped mana floating). Progress is bounded: a source that
        // can't pay gets the cantPay badge (§7) and drops out of .hl-source.
        await clickFirst(page, [
          '.prompt-dock .pool-spend:enabled',
          '.hl-source',                     // cantpay sources render hl-source-cantpay instead
          '.prompt-dock [data-answer=cancel]:enabled',
        ]);
        break;

      case 'chooseAbility':
        await clickFirst(page, ['.ability-popover button:enabled', '.prompt-dock .dock-list button:enabled']);
        break;

      case 'chooseOption':
      case 'playerRequest':
        await clickFirst(page, [
          '.prompt-dock [data-option-key]:enabled',
          '.modal [data-option-key]:enabled',
        ]);
        break;

      case 'choosePile':
        await clickFirst(page, ['.modal [data-answer=pile-0]:enabled']);
        break;

      case 'chooseAmount':
        await clickFirst(page, ['.prompt-dock [data-answer=ok]:enabled']);
        break;

      case 'distribute': {
        const submitted = await clickFirst(page, ['.modal [data-answer=submit]:enabled']);
        if (submitted === null) {
          // prefill under min — pour the first row's own max into it and retry
          const input = page.locator('.distribute-row input').first();
          const max = await input.getAttribute('max').catch(() => null);
          if (max !== null) await input.fill(max).catch(() => {});
        }
        break;
      }

      default:
        throw new Error(`unknown prompt kind rendered: ${snap.promptKind}`);
    }

    await page.waitForTimeout(TICK_MS);
  }

  // ── C3 exit assertions ─────────────────────────────────────────────────────
  const final = (await snapshot(page))!;
  expect(final.over, `game did not finish (turn ${final.turn}, prompt ${final.promptKind})`).toBe(true);
  await expect(page.locator('.over-banner')).toBeVisible();

  expect(combatDeclarations, 'at least one combat declared through the board').toBeGreaterThanOrEqual(1);
  expect(final.counters.patches, 'patch mode really ran').toBeGreaterThan(50);
  expect(final.counters.verifies, 'the §6 backstop probe ran').toBeGreaterThanOrEqual(1);
  expect(final.counters.divergences).toBe(0);
  expect(final.counters.resyncs).toBe(0);
  expect(final.syncMode).toBe('live');
});
