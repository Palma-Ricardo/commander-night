#!/usr/bin/env node
// Table-client screenshot harness — a permanent dev fixture (design T4 is
// "reviewed at the table, not by assertion", and the dev browser can't take the
// inspector extension, so this is how we look at the felt). It renders the live
// Pixi table headless via Playwright over swiftshader WebGL and writes PNGs.
//
//   npm run shoot                                  # ?demo table, 1600x900 → shots/table-1600x900.png
//   npm run shoot -- --size 2560x1440,1280x720     # several viewports at once
//   npm run shoot -- --out shots/artbox.png --label artbox
//   npm run shoot -- --url http://localhost:5273/?demo
//
// If nothing is already serving the URL's port, a vite dev server is started for
// the shot and torn down after; if a dev server is already up, it is reused. The
// script waits until the harness scene has real actors before shooting, then a
// short settle for textures/animation, and prints actor count + camera framing.

import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TABLE_ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const a = { url: 'http://localhost:5273/?demo', out: null, sizes: ['1600x900'], label: '', settle: 1200, waitActors: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--url') { a.url = v; i++; }
    else if (k === '--out') { a.out = v; i++; }
    else if (k === '--size') { a.sizes = v.split(',').map(s => s.trim()).filter(Boolean); i++; }
    else if (k === '--label') { a.label = v; i++; }
    else if (k === '--settle') { a.settle = Number(v); i++; }
    else if (k === '--no-wait') { a.waitActors = false; }
    else if (k === '--help' || k === '-h') { a.help = true; }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('usage: npm run shoot -- [--url U] [--size WxH[,WxH...]] [--out path.png] [--label name] [--settle ms] [--no-wait]');
  process.exit(0);
}

const originOf = u => { const x = new URL(u); return `${x.protocol}//${x.host}`; };

async function reachable(u) {
  try { const r = await fetch(originOf(u), { method: 'GET' }); return r.status < 500; }
  catch { return false; }
}

// ── ensure something is serving the URL ──────────────────────────────────────
let viteServer = null;
if (await reachable(args.url)) {
  console.log(`[shoot] reusing server at ${originOf(args.url)}`);
} else {
  const { createServer } = await import('vite');
  viteServer = await createServer({ root: TABLE_ROOT, configFile: resolve(TABLE_ROOT, 'vite.config.ts'), logLevel: 'warn' });
  await viteServer.listen();
  const port = viteServer.config.server.port ?? 5273;
  const u = new URL(args.url);
  u.host = `localhost:${port}`;
  args.url = u.toString();
  console.log(`[shoot] started dev server on :${port}`);
}

// ── render ───────────────────────────────────────────────────────────────────
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox'],
});

await mkdir(resolve(TABLE_ROOT, 'shots'), { recursive: true });

function outPath(size) {
  if (args.out && args.sizes.length === 1) return resolve(TABLE_ROOT, args.out);
  const stem = (args.out ? args.out.replace(/\.png$/i, '') : `shots/${args.label || 'table'}`);
  return resolve(TABLE_ROOT, `${stem}-${size}.png`);
}

// Expected noise on the offline demo: ws-to-a-missing-bridge, and the Scryfall
// resolver's ladder-walk (a card whose set/number 404s falls through to the next
// lookup URL — a normal miss, not a render fault). Real art faults show visually.
const isNoise = t => /websocket|ws:\/\/|\/ws\b|econnrefused|failed to connect|failed to load resource|status of (404|429)|\[scryfall\]/i.test(t);

let sawError = false;
for (const size of args.sizes) {
  const [w, h] = size.split('x').map(Number);
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' && !isNoise(m.text())) errs.push(m.text()); });
  page.on('pageerror', e => { if (!isNoise(e.message)) errs.push('pageerror: ' + e.message); });

  await page.goto(args.url, { waitUntil: 'domcontentloaded' });
  if (args.waitActors) {
    await page.waitForFunction(() => (globalThis.__night?.scene?.().actors?.length ?? 0) > 0, null, { timeout: 20000 })
      .catch(() => console.warn('[shoot] timed out waiting for actors — shooting anyway'));
  }
  await page.waitForTimeout(args.settle);

  const info = await page.evaluate(() => {
    const s = globalThis.__night?.scene?.();
    return { actors: s?.actors?.length ?? 0, camera: s?.camera ?? null, animating: s?.animating ?? null };
  });
  const p = outPath(size);
  await page.screenshot({ path: p });
  console.log(`[shoot] ${size}  actors=${info.actors}  camera=${info.camera ? JSON.stringify(info.camera) : '-'}  animating=${info.animating}  → ${p}`);
  if (errs.length) { sawError = true; console.warn(`[shoot]   page errors:\n   - ${errs.slice(0, 8).join('\n   - ')}`); }
  await page.close();
}

await browser.close();
if (viteServer) await viteServer.close();
process.exit(sawError ? 1 : 0);
