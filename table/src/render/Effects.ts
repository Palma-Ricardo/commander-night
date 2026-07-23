// The transient-effects layer (design §9). Everything that is *not* a persistent
// card actor — dust rings, mana pips, damage numbers, impact flashes, combat
// arrows, trigger ribbons + ghosts, the phase ribbon, the life vignette, and the
// screen-shake impulse — lives here, spawned by TableScene from the §7.1 events
// and torn down when its lifetime runs out. Two Pixi containers: `worldFx` sits
// among the actors and keystones with the felt (each effect re-projects its own
// anchor every frame through the scene's Projector); `screenFx` is fixed overlay
// (vignette, phase ribbon) that never projects. Shake is a scalar the scene reads
// and applies to the whole stage.
//
// Pixi-owned, so it stays out of the headless tiers — the scene is the only
// caller. Deterministic where it matters (no Math.random on anything that must be
// stable across frames); the small spawn jitter here is per-effect and one-shot,
// so a plain counter-seeded value is fine.

import { Container, Graphics, Text, TextStyle, type Texture, PerspectiveMesh } from 'pixi.js';
import type { Point } from '../layout/types';
import type { Projector } from '../scene/interaction';

/** One live effect. `render` positions its node(s) for the current camera; world
 *  effects project `anchor` through `proj`, screen effects ignore it. */
interface Fx {
  readonly node: Container;
  readonly screen: boolean;
  update(dtMs: number): boolean;   // false ⇒ finished, node destroyed
  render(proj: Projector): void;
}

const DUST = 0xd8c9a0;      // warm felt dust
const CHALK = 0xf0ead6;     // combat arrow
const DMG = 0xff5a48;       // damage number
const ease = (t: number): number => 1 - (1 - t) ** 3;
const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

export class Effects {
  readonly worldFx = new Container();
  readonly screenFx = new Container();
  private readonly list: Fx[] = [];
  private shake = 0;          // current shake amplitude in screen px, decays each frame
  private seed = 0;           // one-shot jitter source (never used for frame-stable values)

  constructor() {
    this.worldFx.eventMode = 'none';
    this.screenFx.eventMode = 'none';
  }

  private add(fx: Fx): void {
    (fx.screen ? this.screenFx : this.worldFx).addChild(fx.node);
    this.list.push(fx);
  }

  /** Advance every effect; drop the finished ones. Also decays the shake. */
  update(dtMs: number): void {
    this.shake *= Math.exp(-dtMs / 90);
    if (this.shake < 0.3) this.shake = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (!this.list[i]!.update(dtMs)) {
        this.list[i]!.node.destroy({ children: true });
        this.list.splice(i, 1);
      }
    }
  }

  /** Project every world effect for this frame's camera; screen effects self-place. */
  render(proj: Projector): void {
    for (const fx of this.list) fx.render(proj);
  }

  /** The current screen-shake offset (design §9: scaled to damage). The scene adds
   *  this to the stage each frame; it decays on its own. */
  shakeOffset(): Point {
    if (this.shake === 0) return { x: 0, y: 0 };
    // A fixed high-frequency wobble, phase-varied per axis — deterministic given
    // the amplitude, so no Math.random in the frame path.
    const p = this.seed;
    return { x: Math.sin(p * 12.9) * this.shake, y: Math.cos(p * 7.3) * this.shake };
  }

  // ── spawns (design §9) ───────────────────────────────────────────────────────

  /** Landing dust (resolve / play): an expanding, fading ring on the felt. */
  dustRing(world: Point, scale = 1): void {
    const g = new Graphics();
    let t = 0;
    const ttl = 380;
    this.add({
      node: g, screen: false,
      update: dt => (t += dt) < ttl,
      render: proj => {
        const k = clamp01(t / ttl);
        const s = proj.scaleAt(world) * scale;
        const c = proj.toScreen(world);
        const r = (14 + 40 * ease(k)) * s;
        g.clear().position.set(c.x, c.y);
        g.circle(0, 0, r).stroke({ width: 3 * s, color: DUST, alpha: 0.5 * (1 - k) });
      },
    });
  }

  /** A mana-coloured pip that darts from a tapped source toward the seat's pool. */
  manaPip(from: Point, to: Point, color: number): void {
    const g = new Graphics();
    let t = 0;
    const ttl = 520;
    this.add({
      node: g, screen: false,
      update: dt => (t += dt) < ttl,
      render: proj => {
        const k = ease(clamp01(t / ttl));
        const w = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k - 30 * Math.sin(Math.PI * k) };
        const s = proj.scaleAt(w);
        const c = proj.toScreen(w);
        g.clear().position.set(c.x, c.y);
        g.circle(0, 0, 6 * s).fill({ color, alpha: 1 - clamp01((t - ttl * 0.6) / (ttl * 0.4)) });
      },
    });
  }

  /** A damage number that arcs up off the target and fades (design §9). */
  damageNumber(world: Point, amount: number, combat: boolean): void {
    const label = new Text({
      text: `-${amount}`,
      style: new TextStyle({
        fontFamily: 'Georgia, serif', fontSize: 34, fontWeight: '800',
        fill: combat ? DMG : 0xf0c04a, stroke: { color: 0x1a0a08, width: 4 },
      }),
    });
    label.anchor.set(0.5, 0.5);
    let t = 0;
    const ttl = 900;
    this.add({
      node: label, screen: false,
      update: dt => (t += dt) < ttl,
      render: proj => {
        const k = clamp01(t / ttl);
        const w = { x: world.x, y: world.y - 90 * ease(k) };
        const c = proj.toScreen(w);
        label.position.set(c.x, c.y);
        label.scale.set(proj.scaleAt(w) * (1 + 0.3 * (1 - k)));
        label.alpha = 1 - clamp01((k - 0.5) / 0.5);
      },
    });
  }

  /** A small floating label that rises and fades — life swings, counter pops
   *  (design §9). Lighter than a damage number: no stroke slab, gentler rise. */
  pip(world: Point, text: string, color: number): void {
    const label = new Text({
      text,
      style: new TextStyle({
        fontFamily: 'ui-monospace, monospace', fontSize: 22, fontWeight: '700',
        fill: color, stroke: { color: 0x120a06, width: 3 },
      }),
    });
    label.anchor.set(0.5, 0.5);
    let t = 0;
    const ttl = 720;
    this.add({
      node: label, screen: false,
      update: dt => (t += dt) < ttl,
      render: proj => {
        const k = clamp01(t / ttl);
        const w = { x: world.x, y: world.y - 46 * ease(k) };
        const c = proj.toScreen(w);
        label.position.set(c.x, c.y);
        const bounce = k < 0.25 ? 1 + 0.5 * (1 - k / 0.25) : 1;
        label.scale.set(proj.scaleAt(w) * bounce);
        label.alpha = 1 - clamp01((k - 0.55) / 0.45);
      },
    });
  }

  /** A white impact flash on a target permanent (design §9). */
  impactFlash(world: Point, scale = 1): void {
    const g = new Graphics();
    let t = 0;
    const ttl = 200;
    this.add({
      node: g, screen: false,
      update: dt => (t += dt) < ttl,
      render: proj => {
        const k = clamp01(t / ttl);
        const s = proj.scaleAt(world) * scale;
        const c = proj.toScreen(world);
        g.clear().position.set(c.x, c.y);
        g.circle(0, 0, (30 + 30 * k) * s).fill({ color: 0xffffff, alpha: 0.7 * (1 - k) });
      },
    });
  }

  /** A chalk combat arrow on the felt from attacker to defender (design §9). Lives
   *  long enough to read the swing, then fades — the state itself keeps combat. */
  attackArrow(from: Point, to: Point, color = CHALK): void {
    const g = new Graphics();
    let t = 0;
    const grow = 220;
    const ttl = 1500;
    this.add({
      node: g, screen: false,
      update: dt => (t += dt) < ttl,
      render: proj => {
        const draw = ease(clamp01(t / grow));
        const fade = 1 - clamp01((t - (ttl - 400)) / 400);
        const a = proj.toScreen(from);
        const bWorld = { x: from.x + (to.x - from.x) * draw, y: from.y + (to.y - from.y) * draw };
        const b = proj.toScreen(bWorld);
        const s = proj.scaleAt(to);
        g.clear().position.set(0, 0);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 4 * s, color, alpha: 0.8 * fade });
        // arrowhead once the shaft has drawn
        if (draw > 0.98) {
          const ang = Math.atan2(b.y - a.y, b.x - a.x);
          const h = 16 * s;
          for (const d of [2.6, -2.6]) {
            g.moveTo(b.x, b.y).lineTo(b.x + Math.cos(ang + d) * h, b.y + Math.sin(ang + d) * h)
              .stroke({ width: 4 * s, color, alpha: 0.8 * fade });
          }
        }
      },
    });
  }

  /** A ribbon streak from a trigger source toward the stack (design §9). */
  triggerRibbon(from: Point, to: Point, color: number): void {
    const g = new Graphics();
    let t = 0;
    const ttl = 620;
    this.add({
      node: g, screen: false,
      update: dt => (t += dt) < ttl,
      render: proj => {
        const k = clamp01(t / ttl);
        const head = ease(k);
        const tail = ease(clamp01((t - 160) / ttl));
        const at = (u: number): Point => proj.toScreen({
          x: from.x + (to.x - from.x) * u,
          y: from.y + (to.y - from.y) * u - 60 * Math.sin(Math.PI * u),
        });
        const s = proj.scaleAt(to);
        const a = at(tail); const b = at(head);
        g.clear().moveTo(a.x, a.y).lineTo(b.x, b.y)
          .stroke({ width: 5 * s, color, alpha: 0.85 * (1 - k) });
      },
    });
  }

  /** An ephemeral ghost of a permanent that flies to the stack and fades — a
   *  triggered/activated ability, so the real card never moves (design §9). */
  ghost(texture: Texture, from: Point, to: Point, scale: number): void {
    const mesh = new PerspectiveMesh({ texture, verticesX: 4, verticesY: 4 });
    let t = 0;
    const ttl = 640;
    const hw = texture.width * scale / 2;
    const hh = texture.height * scale / 2;
    this.add({
      node: mesh, screen: false,
      update: dt => (t += dt) < ttl,
      render: proj => {
        const k = ease(clamp01(t / ttl));
        const w = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k - 50 * Math.sin(Math.PI * k) };
        const sc = 1 - 0.35 * k;
        const c = (dx: number, dy: number): Point => proj.toScreen({ x: w.x + dx * hw * sc, y: w.y + dy * hh * sc });
        const tl = c(-1, -1); const tr = c(1, -1); const br = c(1, 1); const bl = c(-1, 1);
        mesh.setCorners(tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y);
        mesh.alpha = 0.7 * (1 - clamp01((k - 0.4) / 0.6));
        mesh.tint = 0xbfd0ff;   // faint cold ghost tint
      },
    });
  }

  /** A phase ribbon that sweeps across the screen (design §9 `step`). */
  phaseRibbon(text: string, viewport: { w: number; h: number }): void {
    const band = new Container();
    const bg = new Graphics()
      .rect(0, 0, viewport.w, 42).fill({ color: 0x0c0a08, alpha: 0.55 });
    const label = new Text({
      text, style: new TextStyle({
        fontFamily: 'Georgia, serif', fontSize: 20, fontWeight: '700', fill: 0xe8d9b0, letterSpacing: 3,
      }),
    });
    label.anchor.set(0.5, 0.5);
    label.position.set(viewport.w / 2, 21);
    band.addChild(bg, label);
    band.position.set(0, viewport.h * 0.16);
    let t = 0;
    const ttl = 900;
    this.add({
      node: band, screen: true,
      update: dt => (t += dt) < ttl,
      render: () => {
        const k = clamp01(t / ttl);
        band.alpha = k < 0.2 ? k / 0.2 : k > 0.75 ? (1 - k) / 0.25 : 1;
      },
    });
  }

  /** A red vignette pulse on a large life loss (design §9). */
  vignette(viewport: { w: number; h: number }, intensity: number): void {
    const g = new Graphics();
    // a thick soft red frame — cheap stand-in for a radial gradient
    const inset = Math.min(viewport.w, viewport.h) * 0.5;
    g.rect(0, 0, viewport.w, viewport.h).stroke({ width: inset, color: 0x8b0000, alpha: 1 });
    let t = 0;
    const ttl = 620;
    const peak = clamp01(intensity) * 0.5;
    this.add({
      node: g, screen: true,
      update: dt => (t += dt) < ttl,
      render: () => {
        const k = clamp01(t / ttl);
        g.alpha = (k < 0.25 ? k / 0.25 : (1 - k) / 0.75) * peak;
      },
    });
  }

  /** Kick the screen-shake up to `px` (kept if a bigger hit lands mid-decay). */
  addShake(px: number): void {
    this.seed += 1;
    this.shake = Math.max(this.shake, Math.min(px, 22));
  }

  clear(): void {
    for (const fx of this.list) fx.node.destroy({ children: true });
    this.list.length = 0;
    this.shake = 0;
  }
}
