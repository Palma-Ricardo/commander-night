// Texture LOD (design §10). A full Scryfall face is ~488×680 → ~1.3 MB RGBA on
// the GPU. We're not VRAM-constrained on the target machines, so every tier now
// carries full-resolution pixels — the difference is only the *logical* footprint
// each reports to the headless layout, and the art window each shows:
//   • TABLE  logical 200×280 — full portrait cards (the hand, the stack, the
//                       piles), rendered at detail pixels so they stay crisp when
//                       enlarged (a lifted/previewed hand card) or shown on a 1440p+.
//   • ARTBOX logical 200×184 — battlefield permanents (design T4): a name bar over
//                       the card's `art_crop`, rules text trimmed off, supersampled
//                       2× so it stays sharp when a permanent renders large. P/T and
//                       the tap glyph are drawn as live overlays by CardActor.
//   • DETAIL full res  — the stack's big front card (its own tight LRU).
// Each cache is still LRU-capped, generously, so a long game can't leak unbounded.
// The **text-frame** face (name + mana + P/T on a colour-identity panel) is
// rendered into a texture — that is also the permanent fallback for an unresolved
// image (§10: the frame is rendered into a texture, never dropped), so a card with
// no Scryfall art stays fully playable. T4 wires the real art: `face()` resolves
// through the shared Scryfall resolver, decodes the image with crossOrigin
// (WebGL-safe), downscales it (table) or crops it to the art window (artbox), and
// swaps it onto the actor once ready. The detail tier stays a text frame here —
// the full-res hover preview is DOM (design §10), not drawn on the canvas.

import { CanvasSource, Container, Graphics, type Renderer, Sprite, Text, TextStyle, Texture } from 'pixi.js';
import type { Card, ScryfallResolver } from '@night/core';
import backArtUrl from '../assets/cards/Back.png';
import { richText } from './richtext';

export type Tier = 'table' | 'detail' | 'artbox';

export const TIER_SIZE: Record<Tier, { w: number; h: number }> = {
  table: { w: 200, h: 280 },
  detail: { w: 488, h: 680 },
  artbox: { w: 200, h: 184 },
};

const ARTBOX_NAME_H = 34;    // the name bar over the art (logical px), rest is art
const ARTBOX_SS = 2.5;       // art-box supersample factor (crisp when rendered large)

const DETAIL_LRU_CAP = 24;   // §10: only a handful of full-res text frames live at once
const IMAGE_LRU_CAP = 400;   // decoded art-box textures (battlefield); ~590 KB each
const PORTRAIT_HD_CAP = 220;   // full-res portrait art for hand/pile/table tier (~1.3 MB each)
const DETAIL_ART_LRU_CAP = 24;   // full-res stack art (~1.3 MB each)

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

/** `0xrrggbb` → `#rrggbb` for the 2d-canvas art-box builder. */
function cssHex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

/** A distinct URL for the CORS (WebGL) image fetch, so its browser-cache entry can
 *  never collide with a plain `<img>` no-cors entry for the same card (which lacks
 *  the `access-control-allow-origin` header and would poison the CORS load). The
 *  extra query param is inert to Scryfall's CDN. */
function corsCacheKey(url: string): string {
  return url + (url.includes('?') ? '&' : '?') + 'night-cors';
}

/** Derive a card's `art_crop` (just the illustration, ~626×457) from the resolver's
 *  `normal`/`large`/`small` URL by swapping the CDN size segment (design T4). A URL
 *  we don't recognise is returned unchanged — the art-box builder then cover-fits
 *  whatever image it gets, a graceful degrade rather than a blank. */
export function artCropUrl(url: string): string {
  return url.replace(
    /(cards\.scryfall\.io|img\.scryfall\.com)\/(small|normal|large|png|border_crop)\//,
    '$1/art_crop/',
  );
}

/** The gilt ability plate over a trigger-order card's lower half (Issues.txt #27):
 *  the art above says *which* permanent fired; this says what the ability does —
 *  the canvas mirror of the DOM CardView's `.ability-plate`. */
function abilityPlate(card: Card, w: number, h: number): Container {
  const plate = new Container();
  const top = h * 0.42;
  const pad = w * 0.06;
  const g = new Graphics()
    .roundRect(4, top, w - 8, h - top - 4, 8).fill({ color: 0x14100c, alpha: 0.92 })
    .roundRect(5.2, top + 1.2, w - 10.4, h - top - 6.4, 8).stroke({ width: 1.5, color: 0xc9a24a, alpha: 0.92 });
  plate.addChild(g);
  const header = new Text({
    text: 'ABILITY', resolution: 2,
    style: new TextStyle({ fontFamily: 'Georgia, serif', fontSize: 12, fontWeight: '800', fill: 0xf1d792, letterSpacing: 2 }),
  });
  header.position.set(pad, top + 7);
  plate.addChild(header);
  const bodyTop = top + 7 + header.height + 4;
  const body = richText(card.text.join('\n'), {
    fontFamily: 'Georgia, serif',
    fontSize: 11,
    minFontSize: 8,
    fill: 0xe8e2cf,
    lineHeightMul: 14.5 / 11,
    maxW: w - pad * 2,
    maxH: h - bodyTop - 10,
    align: 'left',
    resolution: 2,
  });
  body.position.set(pad, bodyTop);
  plate.addChild(body);
  return plate;
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
  private readonly frames = new Map<string, Texture>();    // key → table-tier text frame
  private readonly detail = new Map<string, Texture>();     // key → detail-tier text frame (LRU)
  private readonly art = new Map<string, Texture>();        // image url → decoded portrait art (LRU)
  private readonly detailArt = new Map<string, Texture>(); // image url → full-res portrait art for the stack (LRU)
  private readonly artbox = new Map<string, Texture>();     // art_crop url → battlefield art box (LRU)
  private readonly artboxFrames = new Map<string, Texture>(); // key → art-box text fallback
  private readonly abilityFaces = new Map<string, Texture>(); // ability id → art+plate face (LRU)
  private readonly loading = new Set<string>();             // image urls currently decoding
  private back?: Texture;                                    // procedural fallback back
  private cardBackTex?: Texture;                             // the real card back art (assets/cards/Back.png)

  /** Fired when an async art texture finishes decoding, so the scene can swap it
   *  onto the actors still showing the text-frame placeholder. */
  onArtReady?: () => void;

  constructor(private readonly renderer: Renderer, private readonly resolver: ScryfallResolver) {}

  /** A stable cache key for the text frame: identical printings share a frame
   *  (per-object counters do not change it). An ability "card" carries its source's
   *  printing but its *own* rules text, so it keys by its ability id — sharing the
   *  source card's frame would show the wrong face on one of them (#27). */
  private key(card: Card): string {
    return `${card.set}:${card.number}:${card.name}${card.ability === true ? `:ab:${card.id}` : ''}`;
  }

  /** The best table-tier texture for `card` *right now*: its resolved Scryfall art
   *  once decoded, otherwise the text-frame fallback (also the permanent miss
   *  fallback, §10). Side effects: requests resolution at `priority` and kicks off
   *  the async decode; when the art lands, `onArtReady` fires and the scene swaps.
   *  The detail tier is not drawn on the canvas (the hover preview is DOM), so it
   *  stays a text frame. */
  face(card: Card, tier: Tier = 'table', priority: 0 | 1 | 2 = 1): Texture {
    this.resolver.resolve(card, priority);
    const entry = this.resolver.store.getState().images[this.resolver.keyOf(card)];
    const artUrl = entry?.status === 'ok' ? entry.url : undefined;

    // The stack's front card is drawn very large, so it takes full-res art (like
    // the hover preview) rather than the downscaled table texture — falling back to
    // the high-res text frame until the image decodes.
    if (tier === 'detail') {
      if (artUrl !== undefined) {
        const hit = touch(this.detailArt, artUrl);
        if (hit !== undefined) return hit;
        this.ensureDetailArt(artUrl);
      }
      // Table-logical text frame as the transient fallback: a detail-sized frame is
      // 488×680 at resolution 1 and would render oversized until the art decodes.
      return this.frameFace(card, 'table');
    }

    if (tier === 'artbox') {
      if (artUrl !== undefined) {
        const url = artCropUrl(artUrl);
        const hit = touch(this.artbox, url);
        if (hit !== undefined) return hit;
        this.ensureArtbox(url, card);
      }
      return this.artboxFrame(card);
    }

    // A trigger-order ability (§7 picker, the carousel): the source's face with
    // the gilt plate carrying this one ability's rule (#27). Composed over the
    // art when it's decoded, over the text frame until then.
    if (card.ability === true) {
      if (artUrl !== undefined) this.ensureArt(artUrl);
      return this.abilityFace(card, artUrl);
    }

    if (artUrl !== undefined) {
      const hit = touch(this.art, artUrl);
      if (hit !== undefined) return hit;
      this.ensureArt(artUrl);
    }
    return this.frameFace(card, 'table');
  }

  /** Art (or text frame) + ability plate, baked once per ability id. Keyed by
   *  whether the art had decoded, so the face upgrades when it lands. */
  private abilityFace(card: Card, artUrl: string | undefined): Texture {
    const art = artUrl !== undefined ? touch(this.art, artUrl) : undefined;
    const k = `${card.id}:${art !== undefined ? 'art' : 'frame'}`;
    const hit = touch(this.abilityFaces, k);
    if (hit !== undefined) return hit;
    const { w, h } = TIER_SIZE.table;
    const root = new Container();
    if (art !== undefined) {
      const sp = new Sprite(art);
      sp.width = w;
      sp.height = h;
      root.addChild(sp);
    } else {
      root.addChild(frameContainer(card, 'table'));
    }
    root.addChild(abilityPlate(card, w, h));
    const tex = this.renderer.generateTexture({ target: root, resolution: 2 });
    root.destroy({ children: true });
    this.abilityFaces.set(k, tex);
    if (this.abilityFaces.size > 64) this.evictOldest(this.abilityFaces);
    return tex;
  }

  /** The battlefield art-box fallback (embossed name plate + colour panel, no rules
   *  box) — shown until the `art_crop` decodes, and the permanent miss fallback. */
  private artboxFrame(card: Card): Texture {
    const k = this.key(card);
    const hit = this.artboxFrames.get(k);
    if (hit !== undefined) return hit;
    const tex = artboxCanvas(card);
    this.artboxFrames.set(k, tex);
    return tex;
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

  /** Load a resolved Scryfall image, build a tier texture from it (`build`), and
   *  cache it under `url` in `into`. `crossOrigin='anonymous'` is required so the
   *  decoded pixels can be uploaded to a WebGL texture untainted.
   *
   *  Scryfall's CDN returns `access-control-allow-origin: *` **only when the
   *  request carries an `Origin` header** (and sets `vary: Origin` there). A plain
   *  `<img>` — the classic client, and our own DOM hover preview (§10) — is a
   *  no-cors request that sends no Origin, so its cached response has neither ACAO
   *  nor `vary`. The browser then reuses that poisoned entry for this CORS request
   *  and blocks it ("No 'Access-Control-Allow-Origin' header is present"). We give
   *  the CORS load its own cache key (`&night-cors`) so it can never collide with a
   *  no-cors entry and always sees the ACAO response. Scryfall ignores the param. */
  private loadImage(
    url: string, into: Map<string, Texture>, build: (img: HTMLImageElement) => Texture, cap = IMAGE_LRU_CAP,
  ): void {
    if (into.has(url) || this.loading.has(url)) return;
    this.loading.add(url);
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      this.loading.delete(url);
      try {
        into.set(url, build(image));
        if (into.size > cap) this.evictOldest(into);
        this.onArtReady?.();
      } catch { /* upload failed — the fallback frame stays, still fully playable */ }
    };
    image.onerror = () => { this.loading.delete(url); };
    image.src = corsCacheKey(url);
  }

  /** Portrait card art for the table tier (hand, piles). Full-res pixels reported at
   *  table-logical size, so a lifted/enlarged hand card and a 1440p+ table stay crisp
   *  (VRAM is not the constraint on the target machines) — same LRU discipline. */
  private ensureArt(url: string): void {
    this.loadImage(url, this.art, detailArtTexture, PORTRAIT_HD_CAP);
  }

  /** Full-res portrait art for the stack's large front card (its own tight LRU, as
   *  each texture is ~1.3 MB — far bigger than a table tile). */
  private ensureDetailArt(url: string): void {
    this.loadImage(url, this.detailArt, detailArtTexture, DETAIL_ART_LRU_CAP);
  }

  /** Battlefield art box: the `art_crop` illustration under an embossed name plate. */
  private ensureArtbox(url: string, card: Card): void {
    this.loadImage(url, this.artbox, img => artboxCanvas(card, img));
  }

  private evictOldest(store: Map<string, Texture>): void {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest !== undefined) { store.get(oldest)?.destroy(true); store.delete(oldest); }
  }

  /** The shared face-down back for every hidden card — the library stack, opponents'
   *  hand fans, morphs (§7.2). Returns the real card-back art once `loadCardBack`
   *  has decoded it, else the procedural back as an immediate fallback. */
  faceDown(): Texture {
    if (this.cardBackTex !== undefined) return this.cardBackTex;
    if (this.back === undefined) this.back = this.renderer.generateTexture(backContainer('table'));
    return this.back;
  }

  /** Preload the real card back (assets/cards/Back.png), downscaled to a table-tier
   *  texture with rounded corners, so `faceDown()` serves it. Best-effort: on
   *  failure every back stays the procedural fallback. Awaited at mount so a back is
   *  the real art from first paint (and the screenshot harness is deterministic). */
  loadCardBack(): Promise<void> {
    if (this.cardBackTex !== undefined) return Promise.resolve();
    return new Promise(resolve => {
      const image = new Image();
      image.onload = () => {
        try { this.cardBackTex = tableArtTexture(image); this.onArtReady?.(); } catch { /* keep the fallback */ }
        resolve();
      };
      image.onerror = () => resolve();
      image.src = backArtUrl;
    });
  }

  destroy(): void {
    for (const store of [this.frames, this.detail, this.art, this.detailArt, this.artbox, this.artboxFrames]) {
      for (const t of store.values()) t.destroy(true);
      store.clear();
    }
    this.back?.destroy(true);
    this.cardBackTex?.destroy(true);
  }
}

/** LRU touch: return the cached texture and move it to the most-recent slot, so
 *  eviction (oldest-first) sheds the least-recently-drawn art. */
function touch(store: Map<string, Texture>, url: string): Texture | undefined {
  const hit = store.get(url);
  if (hit !== undefined) { store.delete(url); store.set(url, hit); }
  return hit;
}

/** Downscale a full Scryfall image into a rounded 200×280 table-tier texture
 *  (§10: full-res would be ~1.3 MB RGBA each and blow the VRAM budget). */
function tableArtTexture(image: HTMLImageElement): Texture {
  return Texture.from(portraitArtCanvas(image, TIER_SIZE.table, 12));
}

/** The same cover-fit art at the detail tier (488×680) for the stack's big front
 *  card. The canvas holds full-res pixels, but the texture reports a *table-logical*
 *  size (via source resolution) so the headless layout — which scales cards against
 *  the 200×280 tile — sizes it identically to a table card, just crisp. */
function detailArtTexture(image: HTMLImageElement): Texture {
  const canvas = portraitArtCanvas(image, TIER_SIZE.detail, 28);
  const resolution = TIER_SIZE.detail.w / TIER_SIZE.table.w;   // ~2.44 px per logical unit
  return new Texture({ source: new CanvasSource({ resource: canvas, resolution }) });
}

/** Cover-fit a Scryfall image into a rounded portrait canvas of the given size. */
function portraitArtCanvas(image: HTMLImageElement, size: { w: number; h: number }, radius: number): HTMLCanvasElement {
  const { w, h } = size;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2d context');
  ctx.imageSmoothingQuality = 'high';
  roundedClip(ctx, w, h, radius);
  const s = Math.max(w / image.width, h / image.height);   // cover-fit
  const dw = image.width * s;
  const dh = image.height * s;
  ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return canvas;
}

/** The battlefield art box (design T4), modelled on Arena's board cards: the card's
 *  `art_crop` in a framed window under an embossed name plate, ringed by a
 *  colour-identity rim, rules text trimmed off. `image` omitted ⇒ the loading/miss
 *  fallback (a colour panel + type line). P/T + tap glyph are live overlays
 *  (CardActor), not baked, since they change under counters/anthems. */
function artboxCanvas(card: Card, image?: HTMLImageElement): Texture {
  const { w, h } = TIER_SIZE.artbox;
  const nameH = ARTBOX_NAME_H;
  const pad = 6;
  const edge = identityColor(card);
  const R = ARTBOX_SS;   // supersample: full-res pixels, table-logical size (below)
  const canvas = document.createElement('canvas');
  canvas.width = w * R;
  canvas.height = h * R;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2d context');
  ctx.scale(R, R);       // draw in logical coords; the backing store is R× denser
  ctx.imageSmoothingQuality = 'high';

  ctx.save();
  roundedClip(ctx, w, h, 12);
  ctx.fillStyle = '#14100b';                 // dark card body
  ctx.fillRect(0, 0, w, h);

  // Art window below the name plate — cover-fit, or a colour panel while it loads.
  const ax = pad, ay = nameH, aw = w - 2 * pad, ah = h - nameH - pad;
  ctx.save();
  pathRoundRect(ctx, ax, ay, aw, ah, 4);
  ctx.clip();
  if (image !== undefined) {
    const s = Math.max(aw / image.width, ah / image.height);
    const dw = image.width * s, dh = image.height * s;
    ctx.drawImage(image, ax + (aw - dw) / 2, ay + (ah - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = cssHex(frameFill(card));
    ctx.globalAlpha = 0.55;
    ctx.fillRect(ax, ay, aw, ah);
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(240,236,222,0.72)';
    ctx.font = 'italic 12px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText([...card.supertypes, ...card.types].join(' ').toLowerCase() || 'card', ax + aw / 2, ay + ah / 2);
    ctx.textAlign = 'left';
  }
  ctx.restore();
  pathRoundRect(ctx, ax + 0.75, ay + 0.75, aw - 1.5, ah - 1.5, 4);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Embossed name plate + engraved name. A small corner radius reads as a bevelled
  // brass bar, not a soft stadium pill (reviewed 2026-07-23).
  drawEmbossPill(ctx, pad, 4, w - 2 * pad, nameH - 8, 4, edge);
  ctx.font = '600 15px Georgia, serif';
  ctx.textBaseline = 'middle';
  const name = ellipsize(ctx, card.name, w - 2 * pad - 20);
  const tx = pad + 10, ty = 4 + (nameH - 8) / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText(name, tx, ty + 1);            // engrave highlight
  ctx.fillStyle = '#2a2016';
  ctx.fillText(name, tx, ty);
  ctx.restore();

  // Colour-identity frame rim around the whole card.
  ctx.lineJoin = 'round';
  pathRoundRect(ctx, 2.5, 2.5, w - 5, h - 5, 10);
  ctx.strokeStyle = cssHex(edge);
  ctx.lineWidth = 3.5;
  ctx.stroke();
  // Report the logical (table-tier) size so the headless layout is unchanged; the
  // extra pixels just make the box sharp when a permanent renders large (T4).
  return new Texture({ source: new CanvasSource({ resource: canvas, resolution: R }) });
}

/** A cream, bevelled "metal" plate with a colour-identity edge — the Arena look,
 *  used for the name plate here and (in Pixi) the P/T badge in CardActor. */
function drawEmbossPill(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, edge: number,
): void {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, '#f3eddc');
  g.addColorStop(0.5, '#ddd4bf');
  g.addColorStop(1, '#c4b99b');
  pathRoundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  pathRoundRect(ctx, x, y, w, h, r);
  ctx.clip();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  pathRoundRect(ctx, x + 1, y + 2, w - 2, h, r);
  ctx.stroke();                              // highlight hugging the top edge
  ctx.strokeStyle = 'rgba(60,46,26,0.35)';
  pathRoundRect(ctx, x + 1, y - 2, w - 2, h, r);
  ctx.stroke();                              // shadow hugging the bottom edge
  ctx.restore();
  pathRoundRect(ctx, x + 0.9, y + 0.9, w - 1.8, h - 1.8, r);
  ctx.strokeStyle = cssHex(edge);
  ctx.lineWidth = 1.75;
  ctx.stroke();
}

/** Colour-identity accent (frame rim, plate edge): the WUBRG hue for mono, gold for
 *  multi, tan/steel/grey for land/artifact/colourless. Brighter than the frame
 *  fills so it reads as a rim, and the at-a-glance colour tell (§7.3) now that the
 *  plate itself is neutral. */
export function identityColor(card: Card): number {
  const c = card.colors;
  if (c.length > 1) return 0xcaa93a;
  if (c.length === 1) {
    return { W: 0xeae3cb, U: 0x3f7fc4, B: 0x5a5566, R: 0xc0432f, G: 0x3f8a54 }[c[0]!] ?? 0x9a9a9a;
  }
  if (card.types.includes('LAND')) return 0x9a8452;
  if (card.types.includes('ARTIFACT')) return 0x9aa0a8;
  return 0x8f8f8f;
}

/** Build (no clip) a rounded-rect path in the 2d context. */
function pathRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Clip the 2d context to the whole-card rounded outline (shared by both art tiers). */
function roundedClip(ctx: CanvasRenderingContext2D, w: number, h: number, r: number): void {
  pathRoundRect(ctx, 0, 0, w, h, r);
  ctx.clip();
}

/** Trim `text` with an ellipsis until it fits `maxWidth` in the context's font. */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + '…';
}
