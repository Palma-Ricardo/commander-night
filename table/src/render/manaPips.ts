// Mana-pip textures for the on-canvas panels — the felt mirror of the DOM
// ManaSymbols. The same bundled SVGs (assets/mana/*.svg + the tap symbol in
// assets/misc/T.svg) rasterized once to Pixi textures, keyed by the brace
// content with slashes stripped: "W/U" → WU, "2/W" → 2W, "B/P" → BP, "T" → T.
//
// `richtext.pipNode` looks a symbol up here and draws a Sprite when a texture
// exists, falling back to its procedural disc for anything unbundled. Preloaded
// once at scene mount (TableScene) so the first paint already carries real pips;
// until then — and in the pure unit tests, which never mount — the lookup
// returns undefined and every pip is the procedural fallback.

import { Texture } from 'pixi.js';

// Every mana SVG, plus the tap symbol, as bundled URLs. Eager so the map is built
// at import; the actual raster happens in loadManaPips().
const MANA_URL: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../assets/mana/*.svg', { eager: true, import: 'default' }),
  ).map(([p, url]) => [p.slice(p.lastIndexOf('/') + 1, -4), url]),
);
import tapUrl from '../assets/misc/T.svg';
MANA_URL.T = tapUrl;

// The pips are viewBox-only square SVGs; rasterize each at this pixel size — crisp
// at the detail tier and under camera zoom, cheap in VRAM (~40 × 128² × 4 ≈ 2.6 MB).
const RASTER = 128;

const textures = new Map<string, Texture>();

/** The rasterized texture for a mana symbol, or undefined if it has no bundled SVG
 *  (an unknown token) or the preload hasn't run yet — callers draw the procedural
 *  pip in that case. Slashes are stripped so "W/U" and "2/W" hit WU/2W. */
export function manaPipTexture(sym: string): Texture | undefined {
  return textures.get(sym.replace(/\//g, ''));
}

/** Rasterize one viewBox-only SVG (no intrinsic size) to a RASTER×RASTER texture.
 *  Chromium honours explicit drawImage destination dims for such SVGs, which is
 *  the only browser this client targets (dev, prod, and the headless shoot). */
function rasterize(url: string): Promise<Texture | undefined> {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = RASTER;
        canvas.height = RASTER;
        const ctx = canvas.getContext('2d');
        if (ctx === null) { resolve(undefined); return; }
        ctx.drawImage(image, 0, 0, RASTER, RASTER);
        resolve(Texture.from(canvas));
      } catch { resolve(undefined); }
    };
    image.onerror = () => resolve(undefined);
    image.src = url;
  });
}

/** Rasterize every bundled mana/tap SVG into the lookup. Best-effort per symbol —
 *  a decode failure leaves that one on the procedural fallback. Idempotent, and
 *  awaited at mount so `manaPipTexture` serves real pips from first paint. */
export async function loadManaPips(): Promise<void> {
  if (textures.size > 0) return;
  await Promise.all(
    Object.entries(MANA_URL).map(async ([key, url]) => {
      const tex = await rasterize(url);
      if (tex !== undefined) textures.set(key, tex);
    }),
  );
}
