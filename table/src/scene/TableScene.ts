// TableScene — owns the single Pixi Application and the flat scene of CardActors
// (design §6.1). Cards live in one actor layer, never inside a zone container, so
// they can move between zones later (T2). T0 responsibilities: bootstrap Pixi,
// build/update actors from a keyframe via layoutFlat, draw the felt + brass
// nameplates so four quadrants read as a table, and expose scene() for the
// semantic harness (§12). Camera, the two-clock director, and animation arrive
// at T1/T2 — here actors snap to their layout spot.

import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { GameState, NightScene, SceneActor } from '@night/core';
import { CardActor } from '../render/CardActor';
import { CardTextures } from '../render/textures';
import { layoutFlat, type Size } from '../layout/flat';

const FELT = 0x1f3a2e;

export class TableScene {
  private app!: Application;
  private textures!: CardTextures;
  private readonly feltLayer = new Container();
  private readonly plateLayer = new Container();
  private readonly actorLayer = new Container();
  private readonly actors = new Map<string, CardActor>();
  private state?: GameState;

  async mount(parent: HTMLElement): Promise<void> {
    this.app = new Application();
    await this.app.init({ background: FELT, antialias: true, resizeTo: parent, resolution: window.devicePixelRatio || 1, autoDensity: true });
    parent.appendChild(this.app.canvas);
    this.textures = new CardTextures(this.app.renderer);
    this.app.stage.addChild(this.feltLayer, this.plateLayer, this.actorLayer);
    setActiveScene(this);
  }

  private get size(): Size {
    return { w: this.app.screen.width, h: this.app.screen.height };
  }

  /** Diff the actor set against a fresh layout of `state`; create/place/retire. */
  renderState(state: GameState): void {
    this.state = state;
    const placed = layoutFlat(state, this.size);
    const live = new Set<string>();

    for (const p of placed) {
      live.add(p.key);
      let actor = this.actors.get(p.key);
      const tex = p.card !== undefined ? this.textures.face(p.card, 'table') : this.textures.faceDown();
      if (actor === undefined) {
        actor = new CardActor(p.key, p.objectId, tex);
        this.actors.set(p.key, actor);
        this.actorLayer.addChild(actor.view);
      } else {
        actor.setTexture(tex);
      }
      actor.place(p.placement, true);
    }

    for (const [key, actor] of this.actors) {
      if (!live.has(key)) { actor.destroy(); this.actors.delete(key); }
    }

    this.drawFelt();
    this.drawPlates(state);
  }

  /** Re-lay the current state at the live viewport size (window resize). */
  resize(): void {
    if (this.state !== undefined) this.renderState(this.state);
  }

  private drawFelt(): void {
    const { w, h } = this.size;
    this.feltLayer.removeChildren();
    const g = new Graphics().rect(0, 0, w, h).fill(FELT);
    // quarter folds, stopping short of the edges (§7.2)
    g.moveTo(w / 2, h * 0.06).lineTo(w / 2, h * 0.94)
      .moveTo(w * 0.06, h / 2).lineTo(w * 0.94, h / 2)
      .stroke({ width: 2, color: 0x000000, alpha: 0.18 });
    this.feltLayer.addChild(g);
  }

  private drawPlates(state: GameState): void {
    this.plateLayer.removeChildren();
    const { w, h } = this.size;
    const spots = [
      { x: 24, y: h - 30 }, { x: 24, y: 20 }, { x: w / 2 + 24, y: 20 }, { x: w / 2 + 24, y: h - 30 },
    ];
    state.players.forEach((pl, i) => {
      const s = spots[i];
      if (s === undefined) return;
      const plate = new Container();
      plate.position.set(s.x, s.y);
      plate.addChild(new Graphics().roundRect(0, 0, 180, 22, 6).fill(0x3a2f1c).stroke({ width: 1, color: 0x8a6a3a }));
      plate.addChild(new Text({
        text: `${pl.name}   ${pl.life}`,
        style: new TextStyle({ fontFamily: 'Georgia, serif', fontSize: 13, fill: 0xe8d9b0, fontWeight: '600' }),
      })).position.set(10, 3);
      this.plateLayer.addChild(plate);
    });
  }

  /** §12 scene accessor — real actor positions for the semantic harness. */
  scene(): NightScene {
    const actors: SceneActor[] = [];
    let animating = false;
    for (const a of this.actors.values()) {
      animating ||= a.animating;
      actors.push({
        key: a.key, objectId: a.objectId, zone: a.placement.zone, ownerId: a.placement.ownerId,
        x: a.pos.x, y: a.pos.y, faceUp: a.placement.faceUp, animating: a.animating,
      });
    }
    return { actors, animating };
  }

  destroy(): void {
    if (getActiveScene() === this) setActiveScene(null);
    for (const a of this.actors.values()) a.destroy();
    this.actors.clear();
    this.textures?.destroy();
    this.app?.destroy(true, { children: true });
  }
}

// Module-level handle so the composition root's harness scene() can read the
// live table without threading the instance through React.
let activeScene: TableScene | null = null;
export function setActiveScene(s: TableScene | null): void { activeScene = s; }
export function getActiveScene(): TableScene | null { return activeScene; }
