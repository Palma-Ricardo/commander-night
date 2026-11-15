// Touch play on a phone (mobile plan, docs/plans/2026-11-14-mobile.md). An
// emulated phone — real touch events, no mouse — plays a land and casts a spell
// through the client's own UI:
//
//   table (landscape): tap a playable hand card on the canvas → the inspect sheet
//     opens with Play/Cast → tap it → the card leaves the hand. The path a phone
//     had no way through before (casting was drag-only, and a finger press never
//     armed the drag).
//   classic (portrait): tap the hand card → it plays (classic casts on click).
//
// Both also check a long-press reads a battlefield card (the table's inspect
// sheet, the classic hover preview). Everything else (mulligan, other players'
// turns, combat) is coasted by the shared semantic driver, so the spec only
// drives by touch the thing it is about.

import { expect, test, type Page } from '@playwright/test';
import type { Id, Prompt } from '@night/core/protocol/protocol';
import type { SceneActor } from '@night/core/harness';
import { createLobby, openHome, repoFile, startGame, submitDeckAndReady } from './chrome';
import { attachConsole, driveGame, promptView, waitForBoard } from './driver';
import { CLIENT, SHOTS } from './target';

const DECK = repoFile('bridge/src/test/resources/decks/upgrades_unleashed.dck');
// The table client is landscape-first; the classic DOM layout is tested upright.
const PHONE = CLIENT === 'table' ? { width: 844, height: 390 } : { width: 390, height: 844 };

test.use({ viewport: PHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

type Kind = 'play' | 'cast';

const handActors = async (page: Page): Promise<SceneActor[]> =>
  (await page.evaluate(() => window.__night!.scene().actors))
    .filter(a => a.zone === 'hand' && a.faceUp && a.objectId !== undefined)
    .sort((a, b) => a.x - b.x);

/** A playable hand card of the wanted kind under a plain (non-combat) priority. */
function playableOf(p: Prompt, hand: SceneActor[], kind: Kind): SceneActor | undefined {
  if (p.kind !== 'priority' || p.combat !== undefined) return undefined;
  return hand.find(a => (p.playable[a.objectId!] ?? []).some(x => x.kind === kind));
}

/** The visible strip of an overlapped fan card: later cards sit on top, each one
 *  step to the right, so a card's own left edge up to its neighbour's is its. */
function tapPoint(hand: SceneActor[], card: SceneActor): { x: number; y: number } {
  const r = card.screen!;
  const next = hand[hand.indexOf(card) + 1]?.screen;
  const visible = next === undefined ? r.width : Math.max(4, next.left - r.left);
  return { x: r.left + Math.min(visible, r.width) / 2, y: r.top + r.height / 2 };
}

/** Coast the game (the shared driver) until I hold plain priority with a hand
 *  card of `kind` playable — or the game ends / the deadline passes. */
async function coastUntil(page: Page, kind: Kind, deadlineAt: number): Promise<Prompt | undefined> {
  const seen = new Set<number>();
  while (Date.now() < deadlineAt) {
    let candidate: number | undefined;
    const r = await driveGame(page, {
      label: `touch:${kind}`, deadlineAt, goalCombat: 0,
      stopWhen: snap => {
        if (snap.promptKind !== 'priority' || snap.combatRole !== null || snap.promptId === null) return false;
        if (seen.has(snap.promptId)) return false;
        candidate = snap.promptId;
        return true;
      },
    });
    if (r.over || !r.stopped || candidate === undefined) return undefined;
    seen.add(candidate);
    const view = await promptView(page);
    if (view === null || view.pending.promptId !== candidate) continue;   // superseded
    const hand = await handActors(page);
    if (playableOf(view.pending, hand, kind) !== undefined) return view.pending;
    // Waiting on a spell: build mana meanwhile, or a one-land seat only ever
    // casts a 1-drop and can deck out first (live-caught on the classic run).
    // Played semantically — the touch path for lands is step 1's job.
    const land = kind === 'cast' ? playableOf(view.pending, hand, 'play') : undefined;
    if (land !== undefined) {
      await page.evaluate(([o, p]) => { window.__night?.click(o, p); }, [land.objectId!, candidate] as [Id, number]);
      await page.waitForTimeout(500);
      continue;
    }
    // not this one: pass it the way the driver would, and keep coasting
    await page.evaluate(id => { window.__night?.pass(id); }, candidate);
  }
  return undefined;
}

/** Let the director settle so the hand fan sits where the scene says it does. */
async function settle(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__night!.scene().animating), { timeout: 10_000 }).toBe(false);
}

/** Tap a playable hand card, check the sheet, press its verb; the card must leave the hand. */
async function tapToPlay(page: Page, kind: Kind, label: RegExp): Promise<void> {
  await settle(page);
  const view = (await promptView(page))!;
  const hand = await handActors(page);
  const card = playableOf(view.pending, hand, kind)!;
  const id: Id = card.objectId!;
  if (CLIENT === 'table') {
    const at = tapPoint(hand, card);
    await page.touchscreen.tap(at.x, at.y);
    const sheet = page.getByTestId('inspect-sheet');
    await expect(sheet, 'a touch tap on a playable hand card opens the inspect sheet').toBeVisible();
    const verb = sheet.locator('button[data-inspect="click"]');
    await expect(verb).toHaveText(label);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/touch-sheet-${kind}.png` });
    await verb.tap();
    await expect(sheet).toBeHidden();
  } else {
    const el = page.locator(`.hand [data-card-id="${id}"]`);
    await el.scrollIntoViewIfNeeded();
    await el.tap();
    // several non-mana actions open the card menu; take the first
    const menu = el.locator('.card-menu button').first();
    if (await menu.isVisible().catch(() => false)) await menu.tap();
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/touch-classic-${kind}.png` });
  }

  // A cast may ask follow-ups (targets, modes, X, payment): the driver answers
  // them until priority comes back, then the card must be gone from the hand.
  await page.waitForTimeout(1000);
  await driveGame(page, {
    label: `touch:${kind}:follow-up`, deadlineAt: Date.now() + 60_000, goalCombat: 0,
    stopWhen: snap => snap.promptKind === 'priority',
  });
  await expect.poll(async () => (await handActors(page)).some(a => a.objectId === id), {
    timeout: 30_000, message: `${kind}: the card left the hand`,
  }).toBe(false);
}

test('touch: play a land and cast a spell on a phone', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  attachConsole(page, 'touch');

  await openHome(page, 'TouchRicardo');
  await createLobby(page);
  await submitDeckAndReady(page, DECK);
  await expect(page.locator('.seat-ready')).toHaveCount(1, { timeout: 10_000 });
  await startGame(page);
  await waitForBoard(page, 120_000);

  const deadline = Date.now() + 15 * 60_000;

  // 1. a land, by tap → Play
  expect(await coastUntil(page, 'play', deadline), 'a turn with a playable land').toBeDefined();
  await tapToPlay(page, 'play', /^Play$/);

  // 2. a long-press on a card of mine on the battlefield opens the sheet too
  await settle(page);
  const cdp = await page.context().newCDPSession(page);
  const longPress = async (r: { left: number; top: number; width: number; height: number }): Promise<void> => {
    const pt = [{ x: r.left + r.width / 2, y: r.top + r.height / 2 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
    await page.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  if (CLIENT === 'table') {
    const mine = (await page.evaluate(() => window.__night!.scene().actors))
      .find(a => a.zone === 'battlefield' && a.faceUp && (a.screen?.width ?? 0) > 8
        && a.screen!.left > 0 && a.screen!.top > 0
        && a.screen!.left + a.screen!.width < PHONE.width && a.screen!.top + a.screen!.height < PHONE.height);
    if (mine !== undefined) {
      await longPress(mine.screen!);
      await expect(page.getByTestId('inspect-sheet'), 'long-press opens the inspect sheet').toBeVisible();
      if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/touch-longpress.png` });
      await page.getByTestId('inspect-sheet').locator('.inspect-close').tap();
      await expect(page.getByTestId('inspect-sheet')).toBeHidden();
    }
  } else {
    const land = page.locator('.battlefield-mine .card').first();
    await land.scrollIntoViewIfNeeded();
    const box = (await land.boundingBox())!;
    await longPress({ left: box.x, top: box.y, width: box.width, height: box.height });
    await expect(page.locator('.hover-preview'), 'long-press previews the card').toBeVisible();
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/touch-classic-longpress.png` });
  }

  // 3. a spell, by tap → Cast (auto-mana pays)
  expect(await coastUntil(page, 'cast', deadline), 'a turn with a castable spell').toBeDefined();
  await tapToPlay(page, 'cast', /^(Cast|Use…)$/);
  if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/touch-after-cast.png` });
});
