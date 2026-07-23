// CardActor (design §6.1). One persistent actor per object, keyed by the stable
// UUID (§3), living in a single flat scene — NOT inside a zone container, so it
// can animate from one zone to another. Holds a current transform and a target
// transform and interpolates toward the target; T0 has no director yet, so it is
// created and snapped to its layout spot. T2 drives `target` from the event
// stream and `update(dt)` becomes the interpolation.

import { Container, Sprite, type Texture } from 'pixi.js';
import type { Id } from '@night/core';
import type { ActorPlacement, Transform } from '../layout/types';

// Re-exported for existing importers; the definitions live in the Pixi-free
// layout/types so the whole layout tier stays headless.
export type { ActorPlacement, Transform } from '../layout/types';

export class CardActor {
  readonly view = new Container();
  private readonly sprite: Sprite;
  private readonly current: Transform = { x: 0, y: 0, rotation: 0, scale: 1 };
  private target: Transform = { x: 0, y: 0, rotation: 0, scale: 1 };

  /** last placement, so scene() can report zone/owner/faceUp per §12 */
  placement: ActorPlacement = { x: 0, y: 0, rotation: 0, scale: 1, zone: 'battlefield', faceUp: true };

  constructor(
    readonly key: string,
    readonly objectId: Id | undefined,
    texture: Texture,
  ) {
    this.sprite = new Sprite(texture);
    this.sprite.anchor.set(0.5);
    this.view.addChild(this.sprite);
  }

  setTexture(texture: Texture): void {
    this.sprite.texture = texture;
  }

  /** Set the destination; T0 snaps immediately (no director). */
  place(p: ActorPlacement, snap = true): void {
    this.placement = p;
    this.target = { x: p.x, y: p.y, rotation: p.rotation, scale: p.scale };
    if (snap) {
      Object.assign(this.current, this.target);
      this.apply();
    }
  }

  /** Interpolate toward target (T2). Returns true while still moving. */
  update(dt: number): boolean {
    const k = Math.min(1, dt * 12);
    let moving = false;
    for (const key of ['x', 'y', 'rotation', 'scale'] as const) {
      const d = this.target[key] - this.current[key];
      if (Math.abs(d) > 0.001) { this.current[key] += d * k; moving = true; }
      else this.current[key] = this.target[key];
    }
    this.apply();
    return moving;
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
    return Math.abs(this.current.x - this.target.x) > 0.001
      || Math.abs(this.current.y - this.target.y) > 0.001;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
