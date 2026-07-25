// The shared auto-player loop (design §12/§13): the bridge live tier's policy
// (play lands, cast each castable once with payMana-cancel bounded, attack with
// one creature, first-legal dialog answers). Both specs run on this driver; the
// resilience spec additionally uses the in-loop reload (same-promptId re-render
// asserted, protocol §14) and stopWhen (seat hand-off points).
//
// T5 — the driver went semantic. It used to read the prompt's meaning out of the
// dock's DOM (option keys, pool colours, distribute rows, combat highlights) and
// answer by clicking. The table client's board is a canvas, so that half was
// simply unreadable; and the dock was never where game meaning lived anyway. The
// loop now reads the pending prompt itself through `window.__night.prompt()` —
// the wire's §8 payload — decides a first-legal answer from it, and submits
// through the semantic actions (`click(objectId)` / `answer(value)` / `pass()`).
// The same file therefore drives either client.
//
// Two things stay view-observed on purpose, because they are what the specs are
// for: the dock must actually *render* for the pending prompt, and the client
// must expose ≥1 enabled control for it (§13's no-dead-end invariant). The dock
// half is DOM in both clients (identical markup); the board half is the harness's
// `highlights()` — DOM rings in the classic client, canvas rings in the table.

import { expect, type Page } from '@playwright/test';
import type { NightPromptView, NightSnapshot } from '@night/core/harness';
import type { AnswerValue, Id } from '@night/core/protocol/protocol';

const TICK_MS = 200;
const DEFAULT_STUCK_MS = 60_000;
const SOCKET_DEAD_MS = 60_000;
const POOL_ORDER = ['W', 'U', 'B', 'R', 'G', 'C'] as const;

// ── the harness handle ───────────────────────────────────────────────────────

export const snapshot = (page: Page): Promise<NightSnapshot | null> =>
  page.evaluate(() => window.__night?.snapshot() ?? null);

/** Like snapshot(), but rides out a page navigation: the handle is briefly absent
 *  while the app boots (a §14 resume, or a dev-server HMR reload mid-run). Only a
 *  handle that never comes back means "not a harness build". */
async function snapshotOrWait(page: Page, label: string): Promise<NightSnapshot> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const snap = await snapshot(page).catch(() => null);   // navigation mid-evaluate
    if (snap !== null) return snap;
    if (Date.now() > deadline) {
      throw new Error(`[${label}] window.__night absent for 30 s — not a harness build?`);
    }
    await page.waitForTimeout(TICK_MS);
  }
}

export const promptView = (page: Page): Promise<NightPromptView | null> =>
  page.evaluate(() => window.__night?.prompt() ?? null);

/** Objects the *board* is offering as clickable right now (§13). */
export const highlights = (page: Page): Promise<Id[]> =>
  page.evaluate(() => window.__night?.highlights() ?? []);

// Every submit carries the promptId it was decided for: a prompt that superseded
// between reading it and answering makes this a no-op instead of a wrong answer to
// the new one (the dock gets that by capturing the id it rendered with).
const answer = (page: Page, value: AnswerValue, promptId: number): Promise<void> =>
  page.evaluate(([v, id]) => { window.__night?.answer(v, id); },
    [value, promptId] as [AnswerValue, number]);

const pass = (page: Page, promptId: number): Promise<void> =>
  page.evaluate(id => { window.__night?.pass(id); }, promptId);

/** Interact with an object exactly as a board click would (§7 affordances). */
const clickObject = (page: Page, id: Id, promptId: number): Promise<void> =>
  page.evaluate(([o, p]) => { window.__night?.click(o, p); }, [id, promptId] as [Id, number]);

/** Enabled dock/modal controls — the view half of the no-dead-end invariant that
 *  both clients render in DOM. `.ability-popover` and `.card-menu` are the classic
 *  client's anchored popovers; the table client folds both into the dock list.
 *
 *  `[role=button]` matters as much as `button`: a modal card grid offers its
 *  candidates as clickable card divs, not buttons. Live-caught 2026-07-24 on
 *  Mosswort Bridge's Hideaway ("Select a card to exile face down") — a required
 *  single-target pick over *library* cards, so there is no Submit, no Decline, and
 *  nothing on the felt to ring; the four grid cards were the whole affordance, and
 *  a button-only count read that perfectly usable prompt as a dead end. */
export async function dockControls(page: Page): Promise<number> {
  return await page.locator(
    [
      '.prompt-dock button:enabled',
      '.modal button:enabled',
      '.modal [role=button]',
      '.ability-popover button:enabled',
      '.card-menu button:enabled',
      '.stranded-target:enabled',
    ].join(', '),
  ).count();
}

/** Every way the client is currently offering to answer: dock controls plus the
 *  objects the board rings (§13 — a rendered prompt always has at least one). */
export async function enabledControls(page: Page): Promise<number> {
  return await dockControls(page) + (await highlights(page)).length;
}

/** Forward the browser's own complaints into the test output, labelled by seat.
 *  Live failures are otherwise mute: the §6 sync discipline explains every resync
 *  and divergence with a `console.warn`/`console.error` in the page, and an
 *  uncaught exception in the client is invisible to an assertion that only reads
 *  counters. Call once per page, right after newPage(). */
export function attachConsole(page: Page, label: string): void {
  page.on('console', msg => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    // Card art is cosmetic by design (§9: an unresolved image falls back to the
    // text frame), and a network that can't reach Scryfall emits one CORS error
    // per card — hundreds of lines that bury the one that matters.
    if (IMAGE_NOISE.test(msg.text())) return;
    console.log(`[${label}/console ${type}] ${msg.text()}`);
  });
  page.on('pageerror', err => console.log(`[${label}/pageerror] ${err.message}`));
}

const IMAGE_NOISE = /scryfall|ERR_FAILED|ERR_NETWORK_CHANGED|Access to fetch|WebGL|GL Driver/i;

/** The board is up: the game store holds a state with all four seats. Replaces
 *  the classic client's `.status-line` + `.seat-panel` DOM probes — the table
 *  client draws both on the canvas. */
export async function waitForBoard(page: Page, timeout: number): Promise<void> {
  await expect.poll(async () => (await snapshot(page))?.seats ?? 0, { timeout }).toBe(4);
}

// ── the loop ─────────────────────────────────────────────────────────────────

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
  /** Prompts this driver acted on. */
  answered: number;
  final: NightSnapshot | null;
}

export async function driveGame(page: Page, opts: DriveOpts): Promise<DriveResult> {
  const assertSync = opts.assertSyncClean ?? true;
  const stuckMs = opts.stuckMs ?? DEFAULT_STUCK_MS;
  const startedAt = Date.now();

  let combatDeclarations = 0;
  let combatToggleClicked = false;   // set when we toggle a candidate; a later
                                     // declared>0 observation = our declaration
  let reloaded = false;
  let answered = 0;
  const actionTried = new Set<string>();
  // payMana loop guard (live-learned 2026-07-18: a {C} pool spend against a
  // {G} cost re-asks forever with a fresh promptId each time): never re-spend a
  // pool colour or re-click a source that failed to shrink the CURRENT remaining.
  let payCycle = { remaining: '', tried: new Set<string>() };
  let lastFingerprint: string | null = null;
  let lastProgressAt = Date.now();
  let lastHeartbeatAt = 0;
  let lastReadyAt = Date.now();
  let snap: NightSnapshot | null = null;

  while (Date.now() < opts.deadlineAt) {
    snap = await snapshotOrWait(page, opts.label);
    if (snap.over) return { over: true, stopped: false, combatDeclarations, reloaded, answered, final: snap };
    const progress: DriveProgress = { reloaded, answered, elapsedMs: Date.now() - startedAt };
    if (opts.stopWhen?.(snap, progress) === true) {
      return { over: false, stopped: true, combatDeclarations, reloaded, answered, final: snap };
    }

    // sync discipline must hold the whole game (§6)
    if (assertSync) {
      expect(snap.counters.resyncs, `[${opts.label}] unexpected resync mid-game`).toBe(0);
      expect(snap.counters.divergences, `[${opts.label}] keyframe-verify divergence`).toBe(0);
    }

    if (Date.now() - lastHeartbeatAt > 60_000) {
      lastHeartbeatAt = Date.now();
      console.log(`[${opts.label}] turn ${snap.turn} · patches ${snap.counters.patches} · verifies ${snap.counters.verifies} · combat ${combatDeclarations} · prompt ${snap.promptKind} · socket ${snap.socket}`);
    }

    // A seat with no socket looks exactly like a seat waiting on the AIs — both
    // are `promptId === null`, and the stuck detector below only watches a
    // *pending* prompt. So watch the socket itself: a reload dips through
    // connecting/helloSent for a moment and a drop reconnects on its own, but a
    // minute of not-ready means this seat is gone and the run should say so
    // rather than poll out the game deadline. `bumped` is excluded — the
    // resilience spec induces it deliberately and recovers by hand.
    // `undefined` = a client build older than the field (a pinned bundle, a
    // deployed host): treat it as healthy rather than as a dead seat.
    if (snap.socket === undefined || snap.socket === 'ready' || snap.socket === 'bumped') {
      lastReadyAt = Date.now();
    } else if (Date.now() - lastReadyAt > SOCKET_DEAD_MS) {
      throw new Error(`[${opts.label}] socket ${snap.socket} for ${SOCKET_DEAD_MS / 1000}s — seat lost (bridge or dev server down?)`);
    }

    if (snap.promptId === null || snap.inflight) {
      await page.waitForTimeout(TICK_MS);
      continue;
    }

    // mid-game reload: the §14 resume must re-render the SAME promptId
    if (opts.reloadAfterMs !== undefined && !reloaded
        && Date.now() - startedAt > opts.reloadAfterMs) {
      const before = snap.promptId;
      console.log(`[${opts.label}] reloading on prompt ${before} (${snap.promptKind})`);
      await page.reload();
      await waitForBoard(page, 60_000);
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

    // the dock must render for the pending prompt — DOM in both clients (§7)
    const dock = page.locator('.prompt-dock');
    if (await dock.count() === 0) {
      await page.waitForTimeout(TICK_MS);
      continue;
    }

    // The no-dead-end invariant: a rendered prompt exposes ≥1 enabled control.
    // Polled, not sampled once — the dock is React DOM and the table's affordance
    // rings are painted from a Pixi effect, so the two can legitimately be one
    // frame apart. A dead end is a *sustained* absence of any way to answer.
    if (!(await dock.getAttribute('class'))?.includes('dock-busy')) {
      await expect.poll(() => enabledControls(page), {
        timeout: 3000,
        message: `[${opts.label}] dead-end prompt ${snap.promptId} (${snap.promptKind})`,
      }).toBeGreaterThan(0);
    }

    // the prompt itself — the driver's whole view of what is being asked
    const view = await promptView(page);
    if (view === null || view.pending.promptId !== snap.promptId) {
      await page.waitForTimeout(TICK_MS);
      continue;                   // superseded between the two reads
    }
    const p = view.pending;

    switch (p.kind) {
      case 'confirm': {
        // default No (keep hands, decline extras) — but the mana-burn ask
        // ("mana in your pool will be lost. Pass anyway?") must be Yes, or
        // No → priority → pass → the same ask loops for the rest of the step
        const yes = /pass anyway|will be lost/i.test(p.message);
        await answer(page, { type: 'confirm', value: yes }, p.promptId);
        break;
      }

      case 'priority': {
        if (p.combat !== undefined) {
          const { role, candidates, declared } = p.combat;
          if (declared.length > 0) {
            // our toggle went through the board: candidate → declared (§8)
            if (combatToggleClicked) {
              combatDeclarations++;
              combatToggleClicked = false;
            }
            await answer(page, { type: 'confirm', value: true }, p.promptId);   // Done
          } else if (role === 'attackers' && candidates.length > 0
                     && combatDeclarations < opts.goalCombat) {
            // attack with one creature until the goal is banked (§13)
            combatToggleClicked = true;
            await clickObject(page, candidates[0]!, p.promptId);
            await page.waitForTimeout(500);   // one toggle = one round trip (§8)
          } else {
            // blockers: never block; post-goal or nothing eligible: done
            await answer(page, { type: 'confirm', value: true }, p.promptId);
          }
          break;
        }
        // until the combat goal is banked: play lands / cast castables
        // (retried per turn — a cast that fizzled on mana early can succeed
        // later). Afterwards coast — a passive seat lets the AIs end the game.
        if (combatDeclarations >= opts.goalCombat) {
          await pass(page, p.promptId);
          break;
        }
        // mana-only objects are never an action (§7, the float-mana lesson); an
        // object with several non-mana actions is answered the way the classic
        // client's popover does — one {object}, and the server disambiguates.
        const turn = snap.turn;
        const next = Object.entries(p.playable)
          .filter(([, actions]) => actions.some(a => a.kind !== 'mana'))
          .map(([id]) => id)
          .find(id => !actionTried.has(`${turn}:${id}`));
        if (next !== undefined) {
          actionTried.add(`${turn}:${next}`);
          await clickObject(page, next, p.promptId);
        } else {
          await pass(page, p.promptId);
        }
        break;
      }

      case 'chooseTargets': {
        const k = view.selected.length;
        const declinable = !p.required || p.min === 0;
        if (declinable) {
          await answer(page, { type: 'cancel' }, p.promptId);
        } else if (p.max > 1 && k >= p.min && k <= p.max) {
          await answer(page, { type: 'objects', objectIds: view.selected }, p.promptId);
        } else {
          // accumulate one more — never re-pick a selected card (that toggles it
          // out). max===1 answers in one click (§8), exactly like a board click.
          const nextTarget = p.candidates.find(id => !view.selected.includes(id));
          if (nextTarget !== undefined) await clickObject(page, nextTarget, p.promptId);
          else if (p.progress !== undefined && p.progress.chosen >= p.min) {
            await answer(page, { type: 'confirm', value: true }, p.promptId);   // incremental: done
          }
        }
        break;
      }

      case 'payMana': {
        // PAY first — floating pool mana, then sources; cancel only when
        // nothing untried is left (cancel-first killed every cast and left the
        // auto-tapped mana floating). Progress is bounded two ways: the server
        // culls sources via cantPay (§7), and the tried-set never re-spends a
        // pool colour or source at an unchanged remaining — a {C} spend against a
        // {G} cost re-asks identically forever otherwise.
        if (payCycle.remaining !== p.remaining) payCycle = { remaining: p.remaining, tried: new Set() };
        const pool = view.pool;
        const colour = pool === undefined ? undefined
          : POOL_ORDER.find(c => pool[c] > 0 && !payCycle.tried.has(`pool:${c}`));
        if (colour !== undefined) {
          payCycle.tried.add(`pool:${colour}`);
          await answer(page, { type: 'mana', color: colour }, p.promptId);
          break;
        }
        const source = (p.sources ?? [])
          .find(id => !view.cantPay.includes(id) && !payCycle.tried.has(`src:${id}`));
        if (source !== undefined) {
          payCycle.tried.add(`src:${source}`);
          await clickObject(page, source, p.promptId);
          break;
        }
        if (p.canCancel) await answer(page, { type: 'cancel' }, p.promptId);
        break;
      }

      case 'chooseAbility':
        await answer(page, { type: 'object', objectId: p.options[0]!.id }, p.promptId);
        break;

      case 'chooseOption':
      case 'playerRequest':
        await answer(page, { type: 'option', key: p.options[0]!.key }, p.promptId);
        break;

      case 'choosePile':
        await answer(page, { type: 'pile', index: 0 }, p.promptId);
        break;

      case 'chooseAmount':
        // the dock's stepper starts at min, and the answer is required (§8)
        await answer(page, { type: 'number', value: p.min }, p.promptId);
        break;

      case 'distribute': {
        // XMage's own split, topped up to the required total from whichever rows
        // still have room (a prefill under min is otherwise unsubmittable)
        const amounts = p.among.map(row => row.suggested ?? row.min ?? 0);
        let short = p.min - amounts.reduce((a, b) => a + b, 0);
        for (let i = 0; i < p.among.length && short > 0; i++) {
          const add = Math.min((p.among[i]!.max ?? p.total) - amounts[i]!, short);
          amounts[i]! += add;
          short -= add;
        }
        await answer(page, {
          type: 'distribution',
          amounts: p.among.map((row, i) => ({ id: row.id, amount: amounts[i]! })),
        }, p.promptId);
        break;
      }

      default:
        throw new Error(`[${opts.label}] unknown prompt kind: ${(p as { kind: string }).kind}`);
    }

    answered++;
    await page.waitForTimeout(TICK_MS);
  }

  return { over: false, stopped: false, combatDeclarations, reloaded, answered, final: snap };
}
