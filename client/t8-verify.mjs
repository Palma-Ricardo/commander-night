// Temporary verification script for Task 8 (hover preview review findings).
// Not committed — deleted after use.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const SCRATCH = '/tmp/claude-1000/-home-ricardop-Projects-commander-night/a2a6737d-1e50-4e03-927e-114cc725b295/scratchpad';
mkdirSync(SCRATCH, { recursive: true });

const BASE = 'http://localhost:5173';

function clampClip(clip, vw, vh) {
  const x = Math.max(0, clip.x);
  const y = Math.max(0, clip.y);
  const width = Math.min(clip.width, vw - x);
  const height = Math.min(clip.height, vh - y);
  return { x, y, width, height };
}

async function findHoverableRightmost(page) {
  const cards = await page.locator('[data-card-id][data-card-name]').all();
  let best = null, bestBox = null;
  for (const c of cards) {
    const box = await c.boundingBox();
    if (box === null) continue;
    if (bestBox === null || box.x + box.width > bestBox.x + bestBox.width) {
      best = c; bestBox = box;
    }
  }
  return { locator: best, box: bestBox };
}

async function flipTest() {
  console.log('\n=== Finding 2: flip-to-left branch, forced narrow viewport ===');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 900, height: 800 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(`${BASE}/#/layout`);
  console.log('navigated to #/layout at 900x800; waiting 22s for scryfall images...');
  await page.waitForTimeout(22000);

  const { locator: card, box: cardBox } = await findHoverableRightmost(page);
  if (card === null) throw new Error('no hoverable card found');
  console.log('rightmost hoverable card box:', cardBox);

  await card.hover();
  await page.waitForSelector('.hover-preview');
  await page.waitForTimeout(300);

  const previewBox = await page.locator('.hover-preview').boundingBox();
  console.log('preview box:', previewBox);
  console.log('viewport:', page.viewportSize());

  const flippedLeft = previewBox.x + previewBox.width <= cardBox.x + 1; // preview entirely left of card's left edge (allow 1px slop)
  const notClipped = previewBox.x >= 0;
  const cardStillVisible = !(
    previewBox.x < cardBox.x + cardBox.width &&
    previewBox.x + previewBox.width > cardBox.x &&
    previewBox.y < cardBox.y + cardBox.height &&
    previewBox.y + previewBox.height > cardBox.y
  );
  console.log('flippedLeft (preview right edge <= card left edge):', flippedLeft);
  console.log('notClipped (preview.x >= 0):', notClipped);
  console.log('cardStillVisible (no rect overlap preview/card):', cardStillVisible);

  // Full-viewport screenshot for context.
  await page.screenshot({ path: `${SCRATCH}/t8flip-full.png` });

  // Tight zoomed crop around both boxes together.
  const pad = 30;
  const minX = Math.min(cardBox.x, previewBox.x) - pad;
  const minY = Math.min(cardBox.y, previewBox.y) - pad;
  const maxX = Math.max(cardBox.x + cardBox.width, previewBox.x + previewBox.width) + pad;
  const maxY = Math.max(cardBox.y + cardBox.height, previewBox.y + previewBox.height) + pad;
  const clip = clampClip({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, 900, 800);
  console.log('crop clip:', clip);
  await page.screenshot({ path: `${SCRATCH}/t8flip-crop.png`, clip });

  await browser.close();
  return { flippedLeft, notClipped, cardStillVisible };
}

async function resizeDismissTest() {
  console.log('\n=== Finding 1: resize mid-hover dismisses the preview ===');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/#/layout`);
  console.log('navigated to #/layout at 1600x900; waiting 22s for scryfall images...');
  await page.waitForTimeout(22000);

  const { locator: card, box: cardBox } = await findHoverableRightmost(page);
  if (card === null) throw new Error('no hoverable card found');
  console.log('card box before hover:', cardBox);

  await card.hover();
  await page.waitForSelector('.hover-preview');
  const countBeforeResize = await page.locator('.hover-preview').count();
  const styleBeforeResize = await page.locator('.hover-preview').evaluate(el => el.getAttribute('style'));
  console.log('count before resize:', countBeforeResize, 'style:', styleBeforeResize);

  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(300);

  const countAfterResize = await page.locator('.hover-preview').count();
  console.log('count after resize:', countAfterResize);

  await page.screenshot({ path: `${SCRATCH}/t8resize-after.png` });

  await browser.close();
  return { countBeforeResize, countAfterResize };
}

const flip = await flipTest();
const resize = await resizeDismissTest();

console.log('\n=== SUMMARY ===');
console.log(JSON.stringify({ flip, resize }, null, 2));

if (!flip.flippedLeft || !flip.notClipped || !flip.cardStillVisible) {
  console.log('FLIP TEST: FAIL');
  process.exitCode = 1;
} else {
  console.log('FLIP TEST: PASS');
}

if (resize.countBeforeResize !== 1 || resize.countAfterResize !== 0) {
  console.log('RESIZE-DISMISS TEST: FAIL');
  process.exitCode = 1;
} else {
  console.log('RESIZE-DISMISS TEST: PASS');
}
