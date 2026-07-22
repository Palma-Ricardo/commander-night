// Texture LOD (design §10). A full Scryfall face is ~488×680 → ~1.3 MB RGBA on
// the GPU, so 300 cards at full res would be ~400 MB of VRAM and crash the tab.
// Two tiers:
//   • TABLE  ~200×280 — everything on the board/hand/piles. 300 cards ≈ 67 MB.
//   • DETAIL full res  — only the hover preview + focused/stack card, a handful
//                        at a time, evicted LRU.
// T0 renders the **text-frame** face (name + mana + P/T on a colour-identity
// panel) into a texture — that is also the permanent fallback for an unresolved
// image (§10: the text frame is rendered into a texture, never dropped), so a
// card with no Scryfall art stays fully playable. T1 swaps Scryfall art in
// through this same cache; the LOD structure does not change.

import { Container, Graphics, type Renderer, Text, TextStyle, Texture } from 'pixi.js';
import type { Card } from '@night/core';

export type Tier = 'table' | 'detail';

export const TIER_SIZE: Record<Tier, { w: number; h: number }> = {
  table: { w: 200, h: 280 },
  detail: { w: 488, h: 680 },
};

const DETAIL_LRU_CAP = 24;   // §10: only a handful of full-res faces live at once

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
  private readonly table = new Map<string, Texture>();   // key → table-tier face
  private readonly detail = new Map<string, Texture>();  // key → detail-tier face (LRU)
  private back?: Texture;

  constructor(private readonly renderer: Renderer) {}

  /** A stable cache key: identical printings share a face (per-object counters
   *  do not change the frame at T0). */
  private key(card: Card): string {
    return `${card.set}:${card.number}:${card.name}`;
  }

  face(card: Card, tier: Tier = 'table'): Texture {
    const store = tier === 'table' ? this.table : this.detail;
    const k = this.key(card);
    const hit = store.get(k);
    if (hit !== undefined) {
      if (tier === 'detail') { store.delete(k); store.set(k, hit); }   // LRU touch
      return hit;
    }
    const tex = this.renderer.generateTexture(frameContainer(card, tier));
    store.set(k, tex);
    if (tier === 'detail' && store.size > DETAIL_LRU_CAP) {
      const oldest = store.keys().next().value as string | undefined;
      if (oldest !== undefined) { store.get(oldest)?.destroy(true); store.delete(oldest); }
    }
    return tex;
  }

  faceDown(): Texture {
    if (this.back === undefined) this.back = this.renderer.generateTexture(backContainer('table'));
    return this.back;
  }

  destroy(): void {
    for (const t of this.table.values()) t.destroy(true);
    for (const t of this.detail.values()) t.destroy(true);
    this.back?.destroy(true);
    this.table.clear();
    this.detail.clear();
  }
}
