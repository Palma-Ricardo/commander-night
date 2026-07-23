// Texture LOD (design §10). A full Scryfall face is ~488×680 → ~1.3 MB RGBA on
// the GPU, so 300 cards at full res would be ~400 MB of VRAM and crash the tab.
// Two tiers:
//   • TABLE  ~200×280 — everything on the board/hand/piles. 300 cards ≈ 67 MB.
//   • DETAIL full res  — only the hover preview + focused/stack card, a handful
//                        at a time, evicted LRU.
// The **text-frame** face (name + mana + P/T on a colour-identity panel) is
// rendered into a texture — that is also the permanent fallback for an unresolved
// image (§10: the text frame is rendered into a texture, never dropped), so a
// card with no Scryfall art stays fully playable. T4 finally wires the real art:
// `face()` resolves through the shared Scryfall resolver, decodes the image with
// crossOrigin (WebGL-safe), downscales it to the table tier, and swaps it onto
// the actor once ready. The detail tier stays a text frame here — the full-res
// hover preview is DOM (design §10), not drawn on the canvas.

import { Container, Graphics, type Renderer, Text, TextStyle, Texture } from 'pixi.js';
import type { Card, ScryfallResolver } from '@night/core';

export type Tier = 'table' | 'detail';

export const TIER_SIZE: Record<Tier, { w: number; h: number }> = {
  table: { w: 200, h: 280 },
  detail: { w: 488, h: 680 },
};

const DETAIL_LRU_CAP = 24;   // §10: only a handful of full-res faces live at once
const IMAGE_LRU_CAP = 400;   // decoded table-tier art textures; 400 × ~224 KB ≈ 90 MB VRAM

// Colour-identity → frame fill. Single colour = its WUBRG hue, multicolour =
// gold, artifact/colourless = steel, land = tan. Read at a glance from across
// the table (§7.3: names are shapes at whole-table zoom).
function frameFill(card: Card): number {
  if (card.types.includes('LAND')) return 0x6b5a3e;
  const c = card.colors;
  if (c.length > 1) return 0xb8992e;
  if (c.length === 1) {
    return { W: 0xe8e2cf, U: 0x2a6db0, B: 0x2b2733, R: 0xb2402f, G: 0x2f7d46 }[c[0]!] ?? 0x8a8a8a;
  }
  return card.types.includes('ARTIFACT') ? 0x8a8f96 : 0x8a8a8a;
}

function textColorFor(fill: number): number {
  // dark frames get light text, light frames dark text
  return fill === 0xe8e2cf ? 0x201c14 : 0xf4efe2;
}

/** Build the text-frame face as a display object at `tier` pixel size. */
function frameContainer(card: Card, tier: Tier): Container {
  const { w, h } = TIER_SIZE[tier];
  const s = w / TIER_SIZE.table.w;   // scale text with the tier
  const fill = frameFill(card);
  const ink = textColorFor(fill);
  const root = new Container();

  const bg = new Graphics()
    .roundRect(0, 0, w, h, 12 * s).fill(fill)
    .roundRect(2 * s, 2 * s, w - 4 * s, h - 4 * s, 10 * s).stroke({ width: 2 * s, color: 0x000000, alpha: 0.35 });
  root.addChild(bg);

  const name = new Text({
    text: card.name,
    style: new TextStyle({ fontFamily: 'Georgia, serif', fontSize: 15 * s, fill: ink, wordWrap: true, wordWrapWidth: w - 20 * s, fontWeight: '600' }),
  });
  name.position.set(10 * s, 8 * s);
  root.addChild(name);

  if (card.manaCost !== undefined && card.manaCost !== '') {
    const mc = new Text({ text: card.manaCost, style: new TextStyle({ fontFamily: 'monospace', fontSize: 12 * s, fill: ink }) });
    mc.anchor.set(1, 0);
    mc.position.set(w - 10 * s, 8 * s);
    root.addChild(mc);
  }

  const typeLine = new Text({
    text: [...card.supertypes, ...card.types].join(' ').toLowerCase() || 'card',
    style: new TextStyle({ fontFamily: 'Georgia, serif', fontSize: 11 * s, fill: ink, fontStyle: 'italic' }),
  });
  typeLine.position.set(10 * s, h * 0.52);
  root.addChild(typeLine);

  if (card.power !== undefined && card.toughness !== undefined) {
    const pt = new Text({ text: `${card.power}/${card.toughness}`, style: new TextStyle({ fontFamily: 'Georgia, serif', fontSize: 18 * s, fill: ink, fontWeight: '700' }) });
    pt.anchor.set(1, 1);
    pt.position.set(w - 10 * s, h - 8 * s);
    root.addChild(pt);
  }
  return root;
}

/** A single face-down back texture, shared by every hidden card. */
function backContainer(tier: Tier): Container {
  const { w, h } = TIER_SIZE[tier];
  const s = w / TIER_SIZE.table.w;
  const root = new Container();
  root.addChild(
    new Graphics()
      .roundRect(0, 0, w, h, 12 * s).fill(0x30241c)
      .roundRect(10 * s, 10 * s, w - 20 * s, h - 20 * s, 8 * s).stroke({ width: 3 * s, color: 0x7a5a34, alpha: 0.8 }),
  );
  return root;
}

export class CardTextures {
  private readonly frames = new Map<string, Texture>();  // key → table-tier text frame
  private readonly detail = new Map<string, Texture>();   // key → detail-tier text frame (LRU)
  private readonly art = new Map<string, Texture>();      // image url → decoded art texture (LRU)
  private readonly loading = new Set<string>();           // image urls currently decoding
  private back?: Texture;

  /** Fired when an async art texture finishes decoding, so the scene can swap it
   *  onto the actors still showing the text-frame placeholder. */
  onArtReady?: () => void;

  constructor(private readonly renderer: Renderer, private readonly resolver: ScryfallResolver) {}

  /** A stable cache key for the text frame: identical printings share a frame
   *  (per-object counters do not change it). */
  private key(card: Card): string {
    return `${card.set}:${card.number}:${card.name}`;
  }

  /** The best table-tier texture for `card` *right now*: its resolved Scryfall art
   *  once decoded, otherwise the text-frame fallback (also the permanent miss
   *  fallback, §10). Side effects: requests resolution at `priority` and kicks off
   *  the async decode; when the art lands, `onArtReady` fires and the scene swaps.
   *  The detail tier is not drawn on the canvas (the hover preview is DOM), so it
   *  stays a text frame. */
  face(card: Card, tier: Tier = 'table', priority: 0 | 1 | 2 = 1): Texture {
    if (tier === 'detail') return this.frameFace(card, 'detail');
    this.resolver.resolve(card, priority);
    const entry = this.resolver.store.getState().images[this.resolver.keyOf(card)];
    if (entry?.status === 'ok' && entry.url !== undefined) {
      const hit = this.art.get(entry.url);
      if (hit !== undefined) { this.art.delete(entry.url); this.art.set(entry.url, hit); return hit; }  // LRU touch
      this.ensureArt(entry.url);
    }
    return this.frameFace(card, 'table');
  }

  private frameFace(card: Card, tier: Tier): Texture {
    const store = tier === 'detail' ? this.detail : this.frames;
    const k = this.key(card);
    const hit = store.get(k);
    if (hit !== undefined) {
      if (tier === 'detail') { store.delete(k); store.set(k, hit); }   // LRU touch
      return hit;
    }
    const tex = this.renderer.generateTexture(frameContainer(card, tier));
    store.set(k, tex);
    if (tier === 'detail' && store.size > DETAIL_LRU_CAP) this.evictOldest(store);
    return tex;
  }

  /** Load a resolved Scryfall image, downscale it to the table tier (§10 VRAM
   *  budget), and cache it. `crossOrigin='anonymous'` keeps the WebGL upload
   *  untainted — Scryfall serves `access-control-allow-origin: *`. */
  private ensureArt(url: string): void {
    if (this.art.has(url) || this.loading.has(url)) return;
    this.loading.add(url);
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      this.loading.delete(url);
      try {
        const tex = tableArtTexture(image);
        this.art.set(url, tex);
        if (this.art.size > IMAGE_LRU_CAP) this.evictOldest(this.art);
        this.onArtReady?.();
      } catch { /* upload failed — the text frame stays, still fully playable */ }
    };
    image.onerror = () => { this.loading.delete(url); };
    image.src = url;
  }

  private evictOldest(store: Map<string, Texture>): void {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest !== undefined) { store.get(oldest)?.destroy(true); store.delete(oldest); }
  }

  faceDown(): Texture {
    if (this.back === undefined) this.back = this.renderer.generateTexture(backContainer('table'));
    return this.back;
  }

  destroy(): void {
    for (const t of this.frames.values()) t.destroy(true);
    for (const t of this.detail.values()) t.destroy(true);
    for (const t of this.art.values()) t.destroy(true);
    this.back?.destroy(true);
    this.frames.clear();
    this.detail.clear();
    this.art.clear();
  }
}

/** Downscale a full Scryfall image into a rounded 200×280 table-tier texture
 *  (§10: full-res would be ~1.3 MB RGBA each and blow the VRAM budget). */
function tableArtTexture(image: HTMLImageElement): Texture {
  const { w, h } = TIER_SIZE.table;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2d context');
  ctx.imageSmoothingQuality = 'high';
  const r = 12;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(w, 0, w, h, r);
  ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r);
  ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
  ctx.clip();
  const s = Math.max(w / image.width, h / image.height);   // cover-fit
  const dw = image.width * s;
  const dh = image.height * s;
  ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return Texture.from(canvas);
}
