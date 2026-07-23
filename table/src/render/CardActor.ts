// CardActor (design §6.1). One persistent actor per object, keyed by the stable
// UUID (§3), living in a single flat scene — NOT inside a zone container, so it
// can animate from one zone to another. Holds a current transform and a
// duration-based tween toward a target; the director (§6.3) assigns the tween's
// duration per step and advances its own clock in lockstep, so an actor's motion
// completes exactly when the director advances `presented` — no exponential
// chase, so snap (duration 0) and burst-compression are both exact.

import { Container, Graphics, GraphicsPath, Sprite, Text, TextStyle, type Texture } from 'pixi.js';
import type { Card } from '@night/core';
import { identityColor } from './textures';
import type { ActorPlacement, ActorSpace, Transform } from '../layout/types';
import type { HighlightSpec } from '../scene/interaction';

// Re-exported for existing importers; the definitions live in the Pixi-free
// layout/types (and scene/interaction) so those tiers stay headless.
export type { ActorPlacement, Transform } from '../layout/types';
export type { HighlightSpec } from '../scene/interaction';

const TWO_PI = Math.PI * 2;

/** ease-out cubic — cards decelerate into place (overshoot/spring is T4). */
const ease = (t: number): number => 1 - (1 - t) ** 3;

/** Shortest signed angular delta a→b, so a tween never spins the long way. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

export class CardActor {
  readonly view = new Container();
  private readonly highlight = new Graphics();   // affordance ring, behind the sprite
  private readonly sprite: Sprite;
  private readonly chrome = new Container();      // P/T badge + tap glyph, above the sprite
  private highlightSpec: HighlightSpec | undefined;
  private chromeSig = '';                         // guards chrome rebuilds (like highlight)
  private readonly from: Transform = { x: 0, y: 0, rotation: 0, scale: 1 };
  private readonly current: Transform = { x: 0, y: 0, rotation: 0, scale: 1 };
  private readonly target: Transform = { x: 0, y: 0, rotation: 0, scale: 1 };
  private elapsed = 0;
  private duration = 0;        // ms; 0 ⇒ settled

  /** last placement, so scene() can report zone/owner/faceUp per §12 */
  placement: ActorPlacement = { x: 0, y: 0, rotation: 0, scale: 1, zone: 'battlefield', faceUp: true };
  /** the card this actor renders (undefined = a face-down back), so the scene can
   *  re-texture it when its Scryfall art decodes after first paint. */
  card: Card | undefined;
  /** which coordinate space the actor currently lives in (§7.1) — the scene
   *  reparents world↔screen when this changes across a transition. */
  space: ActorSpace = 'world';

  constructor(
    readonly key: string,
    readonly objectId: string | undefined,
    texture: Texture,
  ) {
    this.sprite = new Sprite(texture);
    this.sprite.anchor.set(0.5);
    this.view.addChild(this.highlight, this.sprite, this.chrome);   // ring behind, chrome above
  }

  setTexture(texture: Texture): void {
    this.sprite.texture = texture;
    this.refreshChrome();   // texture size drives badge placement; card may have changed
  }

  /** Paint the battlefield art-box overlays (design T4): a P/T badge for creatures,
   *  a dim + tap glyph when tapped. Only battlefield, face-up cards get chrome; the
   *  hand, stack and piles stay bare full-card sprites. Guarded by a signature so
   *  the common no-change transition is a cheap string compare. */
  private refreshChrome(): void {
    const p = this.placement;
    const card = this.card;
    const artbox = p.zone === 'battlefield' && p.faceUp && card !== undefined;
    const tapped = artbox && p.tapped === true;
    const w = this.sprite.texture.width;
    const h = this.sprite.texture.height;
    const pt = artbox && card.power !== undefined && card.toughness !== undefined
      ? `${card.power}/${card.toughness}` : '';
    const count = artbox ? Math.max(1, Math.round(p.count ?? 1)) : 1;
    const sig = `${artbox}|${tapped}|${w}x${h}|${pt}|${count}`;
    if (sig === this.chromeSig) return;
    this.chromeSig = sig;

    this.sprite.tint = tapped ? TAP_DIM : 0xffffff;
    for (const c of this.chrome.removeChildren()) c.destroy({ children: true });
    if (!artbox) return;
    if (pt !== '') this.chrome.addChild(ptBadge(pt, w, h, identityColor(card)));
    if (tapped) this.chrome.addChild(tapGlyph(w, h));
    if (count > 1) this.chrome.addChild(countBadge(count, w, h));
  }

  /** Paint (or clear) the affordance ring (§7). Sized in the sprite's own local
   *  coords so it scales with the card; the ring sits just outside the face. */
  setHighlight(spec: HighlightSpec | undefined): void {
    if (sameHighlight(this.highlightSpec, spec)) return;
    this.highlightSpec = spec;
    const g = this.highlight.clear();
    if (spec === undefined) return;
    const w = this.sprite.texture.width;
    const h = this.sprite.texture.height;
    const pad = Math.round(w * 0.06);
    if (spec.selected === true) {
      g.roundRect(-w / 2 - pad, -h / 2 - pad, w + 2 * pad, h + 2 * pad, 12)
        .fill({ color: spec.color, alpha: 0.22 });
    }
    g.roundRect(-w / 2 - pad, -h / 2 - pad, w + 2 * pad, h + 2 * pad, 12)
      .stroke({ width: Math.max(4, Math.round(w * 0.035)), color: spec.color, alpha: spec.dim === true ? 0.4 : 1 });
  }

  /** Whether this actor currently offers a click affordance (drives the cursor). */
  get highlighted(): boolean { return this.highlightSpec !== undefined; }

  /** Jump instantly to `p` — first sight, snap steps, or the reduced-motion cut. */
  snapTo(p: ActorPlacement): void {
    this.placement = p;
    Object.assign(this.target, transformOf(p));
    Object.assign(this.current, this.target);
    this.duration = 0;
    this.elapsed = 0;
    this.apply();
    this.refreshChrome();
  }

  /** Tween from the current transform to `p` over `durationMs` (0 ⇒ snap). The
   *  from-point is wherever the actor is *now*, so a tween interrupted mid-flight
   *  by the next step continues smoothly from its live position (§6.3). */
  animateTo(p: ActorPlacement, durationMs: number): void {
    this.placement = p;
    Object.assign(this.target, transformOf(p));
    if (durationMs <= 0) { this.snapTo(p); return; }
    Object.assign(this.from, this.current);
    this.duration = durationMs;
    this.elapsed = 0;
    this.refreshChrome();   // chrome doesn't tween — it belongs to the whole card
  }

  /** Place the actor's *current* position without touching its target — used to
   *  seed a freshly-created actor at its entry origin before animating it in. */
  seedCurrent(t: Transform): void {
    Object.assign(this.current, t);
    Object.assign(this.from, t);
    this.apply();
  }

  /** Advance the tween by `dtMs`; returns true while still animating. */
  update(dtMs: number): boolean {
    if (this.duration <= 0) return false;
    this.elapsed += dtMs;
    const t = this.elapsed >= this.duration ? 1 : ease(this.elapsed / this.duration);
    this.current.x = this.from.x + (this.target.x - this.from.x) * t;
    this.current.y = this.from.y + (this.target.y - this.from.y) * t;
    this.current.scale = this.from.scale + (this.target.scale - this.from.scale) * t;
    this.current.rotation = this.from.rotation + angleDelta(this.from.rotation, this.target.rotation) * t;
    this.apply();
    if (this.elapsed >= this.duration) { this.duration = 0; return false; }
    return true;
  }

  private apply(): void {
    this.view.position.set(this.current.x, this.current.y);
    this.view.rotation = this.current.rotation;
    this.view.scale.set(this.current.scale);
  }

  get pos(): { x: number; y: number } {
    return { x: this.current.x, y: this.current.y };
  }

  get animating(): boolean {
    return this.duration > 0;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}

function transformOf(p: ActorPlacement): Transform {
  return { x: p.x, y: p.y, rotation: p.rotation, scale: p.scale };
}

function sameHighlight(a: HighlightSpec | undefined, b: HighlightSpec | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.color === b.color && a.selected === b.selected && a.dim === b.dim;
}

// ── battlefield art-box chrome (design T4) ────────────────────────────────────

const TAP_DIM = 0x8b8b8b;   // sprite tint for a tapped permanent (~55% brightness)

/** A P/T badge pinned to the card's bottom-right corner — the same embossed cream
 *  plate as the name plate, with the colour-identity edge. Text-driven so anthem/
 *  counter swings re-render from the live card (never baked into the texture). */
function ptBadge(pt: string, w: number, h: number, edge: number): Container {
  const c = new Container();
  const label = new Text({
    text: pt,
    style: new TextStyle({ fontFamily: 'Georgia, serif', fontSize: 20, fill: 0x24252c, fontWeight: '700' }),
  });
  label.anchor.set(0.5, 0.5);
  const bw = Math.max(label.width + 18, 38), bh = label.height + 6, r = bh / 2;
  const g = new Graphics();
  g.roundRect(-bw / 2, -bh / 2, bw, bh, r).fill(0xe1d9c0);                    // cream face
  g.moveTo(-bw / 2 + r, -bh / 2 + 1.5).lineTo(bw / 2 - r, -bh / 2 + 1.5)
    .stroke({ width: 1.5, color: 0xffffff, alpha: 0.7 });                    // top highlight
  g.moveTo(-bw / 2 + r, bh / 2 - 1.5).lineTo(bw / 2 - r, bh / 2 - 1.5)
    .stroke({ width: 1.5, color: 0x8a7f63, alpha: 0.5 });                    // bottom shadow
  g.roundRect(-bw / 2 + 0.9, -bh / 2 + 0.9, bw - 1.8, bh - 1.8, r)
    .stroke({ width: 1.75, color: edge, alpha: 1 });                         // identity edge
  label.position.set(0, -1);
  c.addChild(g, label);
  c.position.set(w / 2 - bw / 2 - 6, h / 2 - bh / 2 - 6);                     // bottom-right inset
  return c;
}

/** A "×N" tally for a collapsed stack of identical permanents (basics/tokens),
 *  pinned to the card's top-left — the corner the P/T badge (bottom-right) and the
 *  tap glyph (centre) never reach. Cream-on-ink so it reads over any art. */
function countBadge(n: number, w: number, h: number): Container {
  const c = new Container();
  const label = new Text({
    text: `×${n}`,
    style: new TextStyle({ fontFamily: 'Georgia, serif', fontSize: 19, fill: 0xe1d9c0, fontWeight: '700' }),
  });
  label.anchor.set(0.5, 0.5);
  const bw = Math.max(label.width + 14, 30), bh = label.height + 5, r = bh / 2;
  const g = new Graphics();
  g.roundRect(-bw / 2, -bh / 2, bw, bh, r).fill({ color: 0x24252c, alpha: 0.92 });   // ink face
  g.roundRect(-bw / 2 + 0.9, -bh / 2 + 0.9, bw - 1.8, bh - 1.8, r)
    .stroke({ width: 1.5, color: 0xe1d9c0, alpha: 0.5 });                            // cream edge
  label.position.set(0, -1);
  c.addChild(g, label);
  c.position.set(-w / 2 + bw / 2 + 6, -h / 2 + bh / 2 + 6);                          // top-left inset
  return c;
}

// The {T} tap mark, straight from render/assets/tap.svg (authored in a 600×600
// box). We draw only its glyph path — tinted to the felt ink and set on a dim disc
// so it reads over any card art — dropping the source's background circle. As a
// vector path it stays crisp and recolourable at any zoom.
const TAP_PATH = 'm512 353.5-216 0 79.1-56.3c-29.4-23.3-63.4-35-101.9-35-19.3 0-32.5 3.7-39.5 11-7.1 7.4-10.7 20.7-10.7 39.9 0 53.2 27.4 110 82.2 170.4l-62.3 63.1c-72.5-88.2-108.8-167.1-108.8-236.5 0-41.6 12.5-74.7 37.6-99.3 25.1-24.6 58.5-36.9 100-36.9 50.7 0 106 19.3 165.9 57.8l46.4-79.1 28.2 200.8';

/** The tap glyph: the T.svg arrow, centred on the art over a dim disc. */
function tapGlyph(w: number, h: number): Container {
  const c = new Container();
  const R = Math.min(w, h) * 0.28;
  c.addChild(new Graphics().circle(0, 0, R).fill({ color: 0x000000, alpha: 0.42 }));

  const arrow = new Graphics().path(new GraphicsPath(TAP_PATH)).fill({ color: 0xf4efe2, alpha: 0.98 });
  const b = arrow.getLocalBounds();
  arrow.pivot.set(b.x + b.width / 2, b.y + b.height / 2);   // centre the glyph's bbox
  arrow.scale.set((R * 1.35) / Math.max(b.width, b.height));
  c.addChild(arrow);
  return c;
}
