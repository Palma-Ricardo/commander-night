import { chromium } from '@playwright/test';

async function scan(width, height) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto('http://localhost:5173/#/layout');
  await page.waitForTimeout(600);
  const cards = await page.locator('[data-card-id][data-card-name]').all();
  const inView = [];
  for (const c of cards) {
    const box = await c.boundingBox();
    if (!box) continue;
    if (box.x < 0 || box.y < 0 || box.x + box.width > width || box.y + box.height > height) continue;
    inView.push({ box, rightGap: width - (box.x + box.width) });
  }
  await browser.close();
  const good = inView.filter(c => c.box.x >= 284 && c.rightGap < 284);
  console.log(`w=${width} h=${height}: ${inView.length} in-view; GOOD candidates: ${good.length}`);
  for (const g of good.slice(0, 5)) console.log('   ', JSON.stringify(g));
}

for (const w of [400, 450, 500, 550, 600, 650, 700, 750]) {
  await scan(w, 2000);
}
