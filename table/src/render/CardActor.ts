// CardActor (design §6.1). One persistent actor per object, keyed by the stable
// UUID (§3), living in a single flat scene — NOT inside a zone container, so it
// can animate from one zone to another. Holds a current transform and a
// duration-based tween toward a target; the director (§6.3) assigns the tween's
// duration per step and advances its own clock in lockstep, so an actor's motion
// completes exactly when the director advances `presented` — no exponential
// chase, so snap (duration 0) and burst-compression are both exact.
//
// Perspective (T4): the card face is a PerspectiveMesh, not a Sprite. The actor's
// transform (x, y, rotation, scale) still lives in its own *space* (world for the
// felt, screen for the hand) — the tween, `pos`, and the §12 harness all read it
// unchanged. Rendering is a separate per-frame step: `render(proj)` takes the
// scene's projector, maps the card's four space-corners to the screen, and sets
// them on the mesh, so a world card keystones with the tilted felt while the hand
// (an identity projector) stays an upright rectangle. The affordance ring
// keystones with the face; the P/T / tap / count chrome billboards upright at the
// projected centre so it stays legible on a leaned card.

import { Container, Graphics, GraphicsPath, PerspectiveMesh, Text, TextStyle, type Texture } from 'pixi.js';
import type { Card } from '@night/core';
import { identityColor } from './textures';
import type { ActorPlacement, ActorSpace, Point, Transform } from '../layout/types';
import type { HighlightSpec, Projector, ScreenAnchor } from '../scene/interaction';

// Re-exported for existing importers; the definitions live in the Pixi-free
// layout/types (and scene/interaction) so those tiers stay headless.
export type { ActorPlacement, Transform } from '../layout/types';
export type { HighlightSpec } from '../scene/interaction';

const TWO_PI = Math.PI * 2;
const FACE_VERTS = 8;          // mesh grid per axis — smooth keystone, cheap at card size
const RING_PAD = 0.06;         // affordance ring inset outside the face, in native-tex fractions

// Hand hover-lift (§9), restoring the classic client's `.hand-slot:hover`
// (translateY up + scale 1.35): a pointed-at hand card rises and enlarges so it
// reads in place. HOVER_LIFT is capped so the *bottom* edge never rises above rest
// — see handHoverLift — because a bottom edge sliding up out from under the pointer
// would drop the hover, lower the card, re-enter, and flicker.
const HOVER_GROW = 0.35;       // extra scale at full hover → 1.35×
const HOVER_LIFT = 0.15;       // upward shift, as a fraction of texH·scale (= 0.30·halfHeight)

/** ease-out cubic — cards decelerate into place (overshoot/spring is T4). */
const ease = (t: number): number => 1 - (1 - t) ** 3;

/** The hand hover-lift transform at hover amount `amt` (0..1): the grown draw scale
 *  and the upward shift (own-space px). Kept pure + exported so the no-flicker
 *  invariant — the card's bottom edge never rises above its resting bottom — can be
 *  asserted without Pixi. */
export function handHoverLift(texH: number, scale: number, amt: number): { scale: number; lift: number } {
  return { scale: scale * (1 + HOVER_GROW * amt), lift: amt * HOVER_LIFT * texH * scale };
}

/** Shortest signed angular delta a→b, so a tween never spins the long way. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

export class CardActor {
  readonly view = new Container();
  private readonly glowG = new Graphics();          // colour-identity glow, behind everything (§9 cast)
  private readonly highlight = new Graphics();      // affordance ring, behind the face
  private readonly face: PerspectiveMesh;           // the card, keystoned per frame
  private readonly flashG = new Graphics();         // white impact overlay, above the face (§9 damage)
  private readonly chrome = new Container();         // P/T badge + tap glyph, above the face
  private highlightSpec: HighlightSpec | undefined;
  private chromeSig = '';                            // guards chrome rebuilds (like highlight)
  private readonly from: Transform = { x: 0, y: 0, rotation: 0, scale: 1 };
  private readonly current: Transform = { x: 0, y: 0, rotation: 0, scale: 1 };
  private readonly target: Transform = { x: 0, y: 0, rotation: 0, scale: 1 };
  private elapsed = 0;
  private duration = 0;        // ms; 0 ⇒ settled
  // ── §9 juice channels: each decays to 0 on its own, advanced every frame ──
  private arc = 0;             // upward bow of the current tween's path (own-space units)
  private lastT = 1;           // last eased tween progress, for the arc sample
  private squash = 0;          // 0..1 landing squash (vertical compress + horizontal spread)
  private spin = 0;            // radians of rotation overshoot (tap/untap), decays
  private flashAmt = 0;        // 0..1 white impact flash
  private glowAmt = 0;         // 0..1 cast/colour glow
  private glowColor = 0xffffff;
  private dying = false;       // destroy/sacrifice → ramp `mortis` toward 1
  private mortis = 0;          // 0..1 death desaturation + tip-over
  private hoverAmt = 0;        // 0..1 hand hover-lift (eases toward hoverTarget)
  private hoverTarget = 0;     // the scene sets this: 1 while a hand card is pointed at
  // The face's four screen corners from the last render (TL, TR, BR, BL), so the
  // scene can anchor a DOM hover preview to the actual projected quad (§10).
  private readonly corners: Point[] = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];

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
    this.face = new PerspectiveMesh({ texture, verticesX: FACE_VERTS, verticesY: FACE_VERTS });
    // glow behind the ring; flash over the face but under the P/T/tap chrome.
    this.view.addChild(this.glowG, this.highlight, this.face, this.flashG, this.chrome);
  }

  setTexture(texture: Texture): void {
    this.face.texture = texture;   // rebuilds geometry to the new tex dims; render() re-corners it
    this.refreshChrome();          // texture size drives badge placement; card may have changed
  }

  /** The card's native texture size (portrait table tier or the shorter art box). */
  private get texW(): number { return this.face.texture.width; }
  private get texH(): number { return this.face.texture.height; }

  /** Paint the battlefield art-box overlays (design T4): a P/T badge for creatures,
   *  a dim + tap glyph when tapped. Only battlefield, face-up cards get chrome; the
   *  hand, stack and piles stay bare full-card faces. Guarded by a signature so
   *  the common no-change transition is a cheap string compare. */
  private refreshChrome(): void {
    const p = this.placement;
    const card = this.card;
    const artbox = p.zone === 'battlefield' && p.faceUp && card !== undefined;
    const tapped = artbox && p.tapped === true;
    const w = this.texW;
    const h = this.texH;
    // Only creatures carry a P/T badge. XMage ships power/toughness as "0"/"0" for
    // lands and enchantments too, so gating on `power !== undefined` alone painted a
    // spurious "0/0" on every land — gate on the CREATURE type instead.
    const pt = artbox && card.types.includes('CREATURE')
      && card.power !== undefined && card.toughness !== undefined
      ? `${card.power}/${card.toughness}` : '';
    const counters = artbox ? countersLabel(card.counters) : '';
    const count = artbox ? Math.max(1, Math.round(p.count ?? 1)) : 1;
    // A stack card's printed text box isn't always what's resolving (an ability's
    // source lists all its abilities; a modal spell lists all its modes), so we lay
    // the actual effect over the box — the ability's rules, or the chosen mode(s)
    // (§9 T4). Undefined for plain spells: the printed box already is what resolves.
    const effect = p.zone === 'stack' && p.faceUp ? p.stackEffect : undefined;
    const effectSig = effect ? `${effect.label}~${effect.lines.join('¦')}` : '';
    const sig = `${artbox}|${tapped}|${w}x${h}|${pt}|${counters}|${count}|${effectSig}`;
    if (sig === this.chromeSig) return;
    this.chromeSig = sig;

    // (face tint is applied per-frame in render — it blends the tap dim with the
    //  death ramp, so it can't be baked here.)
    for (const c of this.chrome.removeChildren()) c.destroy({ children: true });
    if (effect) this.chrome.addChild(stackEffectPanel(w, h, effect.label, effect.lines));
    if (!artbox) return;
    if (pt !== '') this.chrome.addChild(ptBadge(pt, w, h, identityColor(card)));
    if (counters !== '') this.chrome.addChild(counterBadge(counters, w, h));
    if (tapped) this.chrome.addChild(tapGlyph(w, h));
    if (count > 1) this.chrome.addChild(countBadge(count, w, h));
  }

  /** Store (or clear) the affordance ring spec (§7). The ring geometry keystones
   *  with the face, so it is *drawn* in `render` from the live projected corners;
   *  here we only latch the spec and note a change. */
  setHighlight(spec: HighlightSpec | undefined): void {
    if (sameHighlight(this.highlightSpec, spec)) return;
    this.highlightSpec = spec;
    if (spec === undefined) this.highlight.clear();
  }

  /** Whether this actor currently offers a click affordance (drives the cursor). */
  get highlighted(): boolean { return this.highlightSpec !== undefined; }

  /** The actor's current scale in its own space — the scene reads it when
   *  re-projecting a card across the world↔screen seam (§6.2). */
  get scaleNow(): number { return this.current.scale; }

  /** Jump instantly to `p` — first sight, snap steps, or the reduced-motion cut. */
  snapTo(p: ActorPlacement): void {
    this.placement = p;
    Object.assign(this.target, transformOf(p));
    Object.assign(this.current, this.target);
    this.duration = 0;
    this.elapsed = 0;
    this.arc = 0;
    this.lastT = 1;
    this.refreshChrome();
  }

  /** Tween from the current transform to `p` over `durationMs` (0 ⇒ snap). The
   *  from-point is wherever the actor is *now*, so a tween interrupted mid-flight
   *  by the next step continues smoothly from its live position (§6.3). `arc` bows
   *  the path upward (§9 cast/draw), in the actor's own-space units. */
  animateTo(p: ActorPlacement, durationMs: number, arc = 0): void {
    this.placement = p;
    Object.assign(this.target, transformOf(p));
    if (durationMs <= 0) { this.snapTo(p); return; }
    Object.assign(this.from, this.current);
    this.duration = durationMs;
    this.elapsed = 0;
    this.arc = arc;
    this.lastT = 0;
    this.refreshChrome();   // chrome doesn't tween — it belongs to the whole card
  }

  // ── §9 juice — one-shot impulses the scene fires off the event stream ─────────

  /** A landing squash on arrival (resolve/play): compress vertically, spread
   *  horizontally, spring back. `strength` 0..1 scales the depth of the squash. */
  land(strength = 1): void { this.squash = Math.max(this.squash, Math.min(1, strength)); }

  /** A rotation overshoot (tap/untap): the card turns a touch past its target and
   *  settles back — the §9 "overshoot ease" without disturbing the tween's target. */
  overshoot(rad: number): void { this.spin = rad; }

  /** A cast/colour-identity glow that blooms then fades (§9 cast). */
  sparkGlow(color: number): void { this.glowColor = color; this.glowAmt = 1; }

  /** A white impact flash (§9 combat damage). */
  sparkFlash(): void { this.flashAmt = 1; }

  /** Begin the death read (§9 destroy/sacrifice): desaturate + tip over as the card
   *  falls to the graveyard. Persists (ramps to full) until the actor is replaced. */
  die(): void { this.dying = true; }

  /** Raise/lower the hand hover-lift (§9). The scene drives this for a pointed-at
   *  hand card; the lift eases in `decayJuice` and is painted every frame. A no-op
   *  read for non-hand cards (the scene never raises them). */
  setHover(on: boolean): void { this.hoverTarget = on ? 1 : 0; }

  /** Place the actor's *current* position without touching its target — used to
   *  seed a freshly-created actor at its entry origin before animating it in. */
  seedCurrent(t: Transform): void {
    Object.assign(this.current, t);
    Object.assign(this.from, t);
  }

  /** Advance the tween by `dtMs`; returns true while still animating. Painting is a
   *  separate step (`render`), driven every frame by the scene's projector. The
   *  §9 juice channels decay every frame whether or not the position tween runs. */
  update(dtMs: number): boolean {
    this.decayJuice(dtMs);
    if (this.duration <= 0) return false;
    this.elapsed += dtMs;
    const t = this.elapsed >= this.duration ? 1 : ease(this.elapsed / this.duration);
    this.lastT = t;
    this.current.x = this.from.x + (this.target.x - this.from.x) * t;
    this.current.y = this.from.y + (this.target.y - this.from.y) * t;
    this.current.scale = this.from.scale + (this.target.scale - this.from.scale) * t;
    this.current.rotation = this.from.rotation + angleDelta(this.from.rotation, this.target.rotation) * t;
    if (this.elapsed >= this.duration) { this.duration = 0; return false; }
    return true;
  }

  /** Decay the transient juice channels toward rest (frame-rate independent). */
  private decayJuice(dtMs: number): void {
    this.squash = Math.max(0, this.squash - dtMs / 260);
    this.flashAmt = Math.max(0, this.flashAmt - dtMs / 240);
    this.glowAmt = Math.max(0, this.glowAmt - dtMs / 520);
    this.spin *= Math.exp(-dtMs / 110);
    if (Math.abs(this.spin) < 0.001) this.spin = 0;
    if (this.dying) this.mortis = Math.min(1, this.mortis + dtMs / 320);
    this.hoverAmt += (this.hoverTarget - this.hoverAmt) * Math.min(1, dtMs / 70);   // ~snappy lift
  }

  /** Project the card through `proj` and paint it: the face's four corners
   *  (keystoned in world space, an upright rect on the hand), the affordance ring
   *  around them, and the chrome billboarded upright at the projected centre. */
  render(proj: Projector): void {
    // §9 juice folded into the geometry: `arc` bows the path up mid-tween, `squash`
    // compresses the face vertically on landing, `spin` + death `mortis` add to the
    // turn. None of these touch the settled transform — they vanish as the channels
    // decay, so `pos`, hit-testing, and the §12 harness stay on the true position.
    const sq = this.squash;
    // hand hover-lift (§9): a grown draw scale + an upward shift, bottom edge pinned.
    const { scale: drawScale, lift } = handHoverLift(this.texH, this.current.scale, this.hoverAmt);
    const hw = (this.texW * drawScale * (1 + 0.16 * sq)) / 2;
    const hh = (this.texH * drawScale * (1 - 0.26 * sq)) / 2;
    const rot = this.current.rotation + this.spin + this.mortis * DEATH_TIP;
    const cx = this.current.x;
    const cy = this.current.y - Math.sin(Math.PI * this.lastT) * this.arc - lift;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    // a space-corner from unit signs (sx, sy) ∈ {−1, +1}, then rotated + placed
    const at = (sx: number, sy: number, padX = 0, padY = 0): Point => {
      const lx = sx * (hw + padX);
      const ly = sy * (hh + padY);
      return { x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos };
    };
    const tl = proj.toScreen(at(-1, -1));
    const tr = proj.toScreen(at(1, -1));
    const br = proj.toScreen(at(1, 1));
    const bl = proj.toScreen(at(-1, 1));
    this.face.setCorners(tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y);
    this.corners[0] = tl; this.corners[1] = tr; this.corners[2] = br; this.corners[3] = bl;

    // face tint: the tap dim, deepened toward grave-grey as death ramps.
    const base = this.placement.tapped === true && this.placement.zone === 'battlefield' ? TAP_DIM : 0xffffff;
    this.face.tint = this.mortis > 0 ? mixColor(base, DEATH_TINT, this.mortis) : base;

    const centre = { x: cx, y: cy };
    const screenScale = drawScale * proj.scaleAt(centre);

    // cast/colour glow: a soft bloom just outside the face, behind everything.
    this.glowG.clear();
    if (this.glowAmt > 0) {
      const gx = 0.14 * this.texW * this.current.scale;
      const gy = 0.14 * this.texH * this.current.scale;
      const g0 = proj.toScreen(at(-1, -1, gx, gy));
      const g1 = proj.toScreen(at(1, -1, gx, gy));
      const g2 = proj.toScreen(at(1, 1, gx, gy));
      const g3 = proj.toScreen(at(-1, 1, gx, gy));
      const gpoly = [g0.x, g0.y, g1.x, g1.y, g2.x, g2.y, g3.x, g3.y];
      this.glowG.poly(gpoly).fill({ color: this.glowColor, alpha: 0.28 * this.glowAmt });
      this.glowG.poly(gpoly).stroke({ width: Math.max(3, 10 * screenScale), color: this.glowColor, alpha: 0.5 * this.glowAmt });
    }

    // impact flash: a white wash over the face.
    this.flashG.clear();
    if (this.flashAmt > 0) {
      this.flashG.poly([tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y])
        .fill({ color: 0xffffff, alpha: 0.7 * this.flashAmt });
    }

    // affordance ring: a keystoned quad just outside the face
    const spec = this.highlightSpec;
    this.highlight.clear();
    if (spec !== undefined) {
      const padX = RING_PAD * this.texW * this.current.scale;
      const padY = RING_PAD * this.texH * this.current.scale;
      const r0 = proj.toScreen(at(-1, -1, padX, padY));
      const r1 = proj.toScreen(at(1, -1, padX, padY));
      const r2 = proj.toScreen(at(1, 1, padX, padY));
      const r3 = proj.toScreen(at(-1, 1, padX, padY));
      const poly = [r0.x, r0.y, r1.x, r1.y, r2.x, r2.y, r3.x, r3.y];
      if (spec.selected === true) this.highlight.poly(poly).fill({ color: spec.color, alpha: 0.22 });
      const width = Math.max(2, this.texW * 0.035 * screenScale);
      this.highlight.poly(poly).stroke({ width, color: spec.color, alpha: spec.dim === true ? 0.4 : 1 });
    }

    // chrome: billboard upright at the projected centre, sized + turned with the card
    const c = proj.toScreen(centre);
    this.chrome.position.set(c.x, c.y);
    this.chrome.rotation = rot;
    this.chrome.scale.set(screenScale);
  }

  /** The on-screen bounding box of the projected face, for anchoring a DOM hover
   *  preview (§10). Read from the last `render`'s corners. */
  bounds(): ScreenAnchor {
    const xs = this.corners.map(p => p.x);
    const ys = this.corners.map(p => p.y);
    const left = Math.min(...xs), top = Math.min(...ys);
    return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
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

const TAP_DIM = 0x8b8b8b;   // face tint for a tapped permanent (~55% brightness)
const DEATH_TINT = 0x4a4640;   // grave-grey the face desaturates toward as it dies (§9)
const DEATH_TIP = 0.42;        // radians a dying card tips over as it falls to the pile
// Corner radius of the embossed metal chrome (P/T / counter / count plates). A
// small radius reads as bevelled brass, not a soft stadium pill (reviewed 2026-07-23).
const PLATE_RADIUS = 4;

/** Blend two packed 0xRRGGBB colours, `t` 0 ⇒ a, 1 ⇒ b (per-channel linear). */
function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

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
  const bw = Math.max(label.width + 18, 38), bh = label.height + 6, r = PLATE_RADIUS;
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

/** A panel laid over a stack card's text-box region (design §9, T4): a gilt header
 *  ("ABILITY" / "MODE") over the effect that's actually on the stack — a triggered/
 *  activated ability's own rules, or a modal spell's chosen mode(s) — so it doesn't
 *  read as the source permanent's full box or all of a modal's modes. Keeps the
 *  card's name + art above it visible. Sized to the card texture, billboarded and
 *  scaled with the face by `render`. */
function stackEffectPanel(w: number, h: number, label: string, lines: string[]): Container {
  const c = new Container();
  const panelW = w * 0.88;
  // The printed text box sits below the type line (~55% down) and runs to the
  // bottom info bar; cover that band, leaving name + art above it in the clear.
  const top = h * 0.05;
  const bottom = h * 0.46;
  const panelH = bottom - top;
  const pad = w * 0.05;

  const g = new Graphics();
  g.roundRect(-panelW / 2, top, panelW, panelH, PLATE_RADIUS).fill({ color: 0x14100c, alpha: 0.9 });
  g.roundRect(-panelW / 2 + 1.2, top + 1.2, panelW - 2.4, panelH - 2.4, PLATE_RADIUS)
    .stroke({ width: 1.5, color: 0xc9a24a, alpha: 0.92 });                    // gilt edge
  c.addChild(g);

  const header = new Text({
    text: label,
    style: new TextStyle({
      fontFamily: 'Georgia, serif', fontSize: Math.round(h * 0.05), fontWeight: '800',
      fill: 0xf1d792, letterSpacing: Math.round(h * 0.01),
    }),
  });
  header.anchor.set(0.5, 0);
  header.position.set(0, top + pad * 0.5);
  c.addChild(header);

  if (lines.length > 0) {
    const body = new Text({
      text: lines.join('\n'),
      style: new TextStyle({
        fontFamily: 'Georgia, serif', fontSize: Math.round(h * 0.043), fill: 0xe8e2cf,
        wordWrap: true, wordWrapWidth: panelW - pad * 2, align: 'center', lineHeight: Math.round(h * 0.057),
      }),
    });
    body.anchor.set(0.5, 0);
    body.position.set(0, top + pad * 0.6 + header.height);
    c.addChild(body);
  }
  return c;
}

/** Compact label for a permanent's counters — the buffed P/T is already on the
 *  badge, so this is the "why": `+1/+1` and `-1/-1` collapse to a signed pair,
 *  anything else (charge, loyalty, oil, …) reads as `N× name`. Multiple kinds
 *  join on one plate. Empty ⇒ no counter chrome. */
function countersLabel(counters: Card['counters']): string {
  if (counters === undefined || counters.length === 0) return '';
  return counters
    .filter(c => c.count !== 0)
    .map(c => {
      const n = c.name.toLowerCase();
      if (n === '+1/+1') return `+${c.count}/+${c.count}`;
      if (n === '-1/-1') return `−${c.count}/−${c.count}`;
      const short = c.name.length > 8 ? c.name.slice(0, 8) : c.name;
      return `${c.count}× ${short}`;
    })
    .join('  ');
}

/** A counter plate pinned to the card's top-right — cream-on-ink like the count
 *  tally, tinted green for growth (+1/+1) and red for shrink (−1/−1) so the sign
 *  reads at a glance. Top-left holds the ×N collapse tally, so these never clash. */
function counterBadge(label: string, w: number, h: number): Container {
  const c = new Container();
  const grow = label.startsWith('+');
  const shrink = label.startsWith('−');
  const ink = grow ? 0x9be8a8 : shrink ? 0xf0a89a : 0xe1d9c0;
  const text = new Text({
    text: label,
    style: new TextStyle({ fontFamily: 'Georgia, serif', fontSize: 18, fill: ink, fontWeight: '700' }),
  });
  text.anchor.set(0.5, 0.5);
  const bw = Math.max(text.width + 14, 30), bh = text.height + 5, r = PLATE_RADIUS;
  const g = new Graphics();
  g.roundRect(-bw / 2, -bh / 2, bw, bh, r).fill({ color: 0x24252c, alpha: 0.92 });   // ink face
  g.roundRect(-bw / 2 + 0.9, -bh / 2 + 0.9, bw - 1.8, bh - 1.8, r)
    .stroke({ width: 1.5, color: ink, alpha: 0.5 });                                 // tinted edge
  text.position.set(0, -1);
  c.addChild(g, text);
  c.position.set(w / 2 - bw / 2 - 6, -h / 2 + bh / 2 + 6);                           // top-right inset
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
  const bw = Math.max(label.width + 14, 30), bh = label.height + 5, r = PLATE_RADIUS;
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
