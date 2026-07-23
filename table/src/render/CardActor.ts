// CardActor (design §6.1). One persistent actor per object, keyed by the stable
// UUID (§3), living in a single flat scene — NOT inside a zone container, so it
// can animate from one zone to another. Holds a current transform and a
// duration-based tween toward a target; the director (§6.3) assigns the tween's
// duration per step and advances its own clock in lockstep, so an actor's motion
// completes exactly when the director advances `presented` — no exponential
// chase, so snap (duration 0) and burst-compression are both exact.

import { Container, Sprite, type Texture } from 'pixi.js';
import type { ActorPlacement, ActorSpace, Transform } from '../layout/types';

// Re-exported for existing importers; the definitions live in the Pixi-free
// layout/types so the whole layout tier stays headless.
export type { ActorPlacement, Transform } from '../layout/types';

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
  private readonly sprite: Sprite;
  private readonly from: Transform = { x: 0, y: 0, rotation: 0, scale: 1 };
  private readonly current: Transform = { x: 0, y: 0, rotation: 0, scale: 1 };
  private readonly target: Transform = { x: 0, y: 0, rotation: 0, scale: 1 };
  private elapsed = 0;
  private duration = 0;        // ms; 0 ⇒ settled

  /** last placement, so scene() can report zone/owner/faceUp per §12 */
  placement: ActorPlacement = { x: 0, y: 0, rotation: 0, scale: 1, zone: 'battlefield', faceUp: true };
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
    this.view.addChild(this.sprite);
  }

  setTexture(texture: Texture): void {
    this.sprite.texture = texture;
  }

  /** Jump instantly to `p` — first sight, snap steps, or the reduced-motion cut. */
  snapTo(p: ActorPlacement): void {
    this.placement = p;
    Object.assign(this.target, transformOf(p));
    Object.assign(this.current, this.target);
    this.duration = 0;
    this.elapsed = 0;
    this.apply();
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
