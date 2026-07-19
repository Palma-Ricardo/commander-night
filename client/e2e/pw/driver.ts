// The shared auto-player loop (design §13): the bridge live tier's policy
// (play lands, cast each castable once with payMana-cancel bounded, attack
// with one creature, first-legal dialog answers) driven through visible UI
// only. C3's single-seat spec and C4's two-browser resilience spec both run
// on this driver; C4 additionally uses the in-loop reload (same-promptId
// re-render asserted, protocol §14) and stopWhen (seat hand-off points).

import { expect, type Page } from '@playwright/test';
import type { NightSnapshot } from '../../src/app';

const TICK_MS = 200;
const DEFAULT_STUCK_MS = 60_000;

export const snapshot = (page: Page): Promise<NightSnapshot | null> =>
  page.evaluate(() => window.__night?.snapshot() ?? null);

/** One enabled affordance somewhere: a dock/modal/popover button or a
 *  highlighted board object (§13 UI-completeness invariant). */
export async function enabledControls(page: Page): Promise<number> {
  return await page.locator(
    [
      '.prompt-dock button:enabled',
      '.modal button:enabled',
      '.ability-popover button:enabled',
      '.card-menu button:enabled',
      '.stranded-target:enabled',
      '.hl-action', '.hl-target', '.hl-combat', '.hl-declared', '.hl-source',
    ].join(', '),
  ).count();
}

export async function clickFirst(page: Page, selectors: string[]): Promise<string | null> {
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

export interface DriveOpts {
  label: string;                 // heartbeat prefix
  deadlineAt: number;            // absolute ms — give up (caller asserts over)
  /** Combat declarations to bank before coasting; 0 = coast from the start
   *  (pass everything, answer only what must be answered). */
  goalCombat: number;
  /** Assert resyncs/divergences stay 0 every tick (§6). Default true. */
  assertSyncClean?: boolean;
  stuckMs?: number;
  /** Reload the page once, at the first pending prompt after this many ms —
   *  asserts the SAME promptId re-renders after resume (protocol §14). */
  reloadAfterMs?: number;
  /** Return early when true (seat hand-off; the caller resumes elsewhere).
   *  Gets the driver's own progress, so hand-off points can be sequenced on
   *  *events* ("once the reload is done and a few prompts have gone by")
   *  rather than wall-clock — AI-pace games have finished in as little as
   *  3 minutes, which no fixed deadline survives. */
  stopWhen?: (snap: NightSnapshot, progress: DriveProgress) => boolean;
}

export interface DriveProgress {
  reloaded: boolean;
  /** Prompts this driver has acted on. */
  answered: number;
  elapsedMs: number;
}

export interface DriveResult {
  over: boolean;
  stopped: boolean;              // stopWhen fired
  combatDeclarations: number;
  reloaded: boolean;
  final: NightSnapshot | null;
}

export async function driveGame(page: Page, opts: DriveOpts): Promise<DriveResult> {
  const assertSync = opts.assertSyncClean ?? true;
  const stuckMs = opts.stuckMs ?? DEFAULT_STUCK_MS;
  const startedAt = Date.now();

  let combatDeclarations = 0;
  let combatToggleClicked = false;   // set when we click a candidate; a later
                                     // declared>0 observation = our declaration
  let reloaded = false;
  let answered = 0;
  const actionTried = new Set<string>();
  // payMana loop guard (live-learned 2026-07-18: a {C} pool spend against a
  // {G} cost re-asks forever with a fresh promptId each time): never re-click
  // a pool color or source that failed to shrink the CURRENT remaining.
  let payCycle = { remaining: '', tried: new Set<string>() };
  let lastFingerprint: string | null = null;
  let lastProgressAt = Date.now();
  let lastHeartbeatAt = 0;
  let snap: NightSnapshot | null = null;

  while (Date.now() < opts.deadlineAt) {
    snap = await snapshot(page);
    if (snap === null) throw new Error(`[${opts.label}] window.__night missing — not a dev build?`);
    if (snap.over) return { over: true, stopped: false, combatDeclarations, reloaded, final: snap };
    const progress: DriveProgress = { reloaded, answered, elapsedMs: Date.now() - startedAt };
    if (opts.stopWhen?.(snap, progress) === true) {
      return { over: false, stopped: true, combatDeclarations, reloaded, final: snap };
    }

    // sync discipline must hold the whole game (§6)
    if (assertSync) {
      expect(snap.counters.resyncs, `[${opts.label}] unexpected resync mid-game`).toBe(0);
      expect(snap.counters.divergences, `[${opts.label}] keyframe-verify divergence`).toBe(0);
    }

    if (Date.now() - lastHeartbeatAt > 60_000) {
      lastHeartbeatAt = Date.now();
      console.log(`[${opts.label}] turn ${snap.turn} · patches ${snap.counters.patches} · verifies ${snap.counters.verifies} · combat ${combatDeclarations} · prompt ${snap.promptKind}`);
    }

    if (snap.promptId === null || snap.inflight) {
      await page.waitForTimeout(TICK_MS);
      continue;
    }

    // C4 mid-game reload: the §14 resume must re-render the SAME promptId
    if (opts.reloadAfterMs !== undefined && !reloaded
        && Date.now() - startedAt > opts.reloadAfterMs) {
      const before = snap.promptId;
      console.log(`[${opts.label}] reloading on prompt ${before} (${snap.promptKind})`);
      await page.reload();
      await expect(page.locator('.status-line')).toBeVisible({ timeout: 60_000 });
      await expect.poll(async () => (await snapshot(page))?.promptId ?? null,
        { timeout: 30_000 }).toBe(before);
      reloaded = true;
      lastFingerprint = null;
      lastProgressAt = Date.now();
      continue;
    }

    // stuck/dead-end tracking, per §13: 60 s without progress = fail. payMana
    // re-asks mint a fresh promptId per ask, so there the fingerprint is the
    // remaining cost — an unchanged remaining is non-progress no matter how
    // many prompt ids churned past.
    const fingerprint = snap.promptKind === 'payMana'
      ? `pay:${snap.payRemaining}` : `id:${snap.promptId}`;
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > stuckMs) {
      throw new Error(`[${opts.label}] stuck ≥${stuckMs / 1000}s on ${fingerprint} (${snap.promptKind})`);
    }

    const dock = page.locator('.prompt-dock');
    if (await dock.count() === 0) {
      await page.waitForTimeout(TICK_MS);
      continue;
    }

    // the no-dead-end invariant: a rendered prompt exposes ≥1 enabled control
    if (!(await dock.getAttribute('class'))?.includes('dock-busy')) {
      expect(await enabledControls(page),
        `[${opts.label}] dead-end prompt ${snap.promptId} (${snap.promptKind})`).toBeGreaterThan(0);
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
          } else if (snap.combatRole === 'attackers' && candidates > 0
                     && combatDeclarations < opts.goalCombat) {
            // attack with one creature until the goal is banked (§13)
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
        if (combatDeclarations >= opts.goalCombat) {
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
          // accumulate one more — never re-click a selected card (that toggles it out).
          // Stranded candidates (pile zones) are only offered in the dock.
          await clickFirst(page, [
            '.modal .card:not(.card-selected)',
            '.hl-target:not(.card-selected)',
            '.stranded-target:not(.card-selected):enabled',
          ]);
        }
        break;
      }

      case 'payMana': {
        // PAY first — floating pool mana, then sources; cancel only when
        // nothing untried is left (cancel-first killed every cast and left the
        // auto-tapped mana floating). Progress is bounded two ways: the server
        // culls sources via the cantPay badge (§7), and the tried-set below
        // never re-clicks a pool color or source at an unchanged remaining —
        // a {C} spend against a {G} cost re-asks identically forever otherwise.
        const remaining = snap.payRemaining ?? '';
        if (payCycle.remaining !== remaining) payCycle = { remaining, tried: new Set() };
        let paid = false;
        const pool = page.locator('.prompt-dock .pool-spend:enabled');
        for (let i = 0; i < await pool.count() && !paid; i++) {
          const el = pool.nth(i);
          const key = `pool:${await el.getAttribute('data-mana').catch(() => null)}`;
          if (payCycle.tried.has(key)) continue;
          payCycle.tried.add(key);
          await el.click({ timeout: 3000, force: true }).catch(() => {});
          paid = true;
        }
        const sources = page.locator('.hl-source');   // cantpay renders hl-source-cantpay instead
        for (let i = 0; i < await sources.count() && !paid; i++) {
          const el = sources.nth(i);
          const key = `src:${await el.getAttribute('data-card-id').catch(() => null)}`;
          if (payCycle.tried.has(key)) continue;
          payCycle.tried.add(key);
          await el.click({ timeout: 3000, force: true }).catch(() => {});
          paid = true;
        }
        if (!paid) await clickFirst(page, ['.prompt-dock [data-answer=cancel]:enabled']);
        break;
      }

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
        throw new Error(`[${opts.label}] unknown prompt kind rendered: ${snap.promptKind}`);
    }

    answered++;
    await page.waitForTimeout(TICK_MS);
  }

  return { over: false, stopped: false, combatDeclarations, reloaded, final: snap };
}
