// TableScene — owns the single Pixi Application, the flat scene of CardActors
// (design §6.1), and the camera rig (§7.3). T1 draws the surveyed quadrant world:
// a world layer (camera-transformed) holding the felt, the seat furniture
// (nameplates, lamplight, pile footprints) and every world-space actor; and a
// screen layer (fixed) holding your hand. Cards live in one actor layer, never
// inside a zone container, so they can move between zones later (T2). No animation
// yet — actors snap to their layout target and the camera cuts between presets.

import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { GameState, Id, NightScene, SceneActor } from '@night/core';
import { CardActor } from '../render/CardActor';
import { CardTextures } from '../render/textures';
import { layoutScreen } from '../layout/screen';
import { layoutWorld, NAMEPLATE, seatLayouts, seatOfPlayer, WORLD, type SeatLayout } from '../layout/world';
import type { PileZone } from '../layout/world';
import type { PlacedActor, Size } from '../layout/types';
import { camera, seatView, TABLE_VIEW } from '../camera/camera';
import { CameraController } from '../camera/controller';

const RAIL = 0x0e0b08;      // the floor the table sits on
const FELT = 0x1f3a2e;
const FELT_EDGE = 0x14261d;
const BRASS = 0x8a6a3a;
const BRASS_FILL = 0x3a2f1c;
const INK = 0xe8d9b0;
const DIM_ALPHA = 0.72;

export class TableScene {
  private app!: Application;
  private textures!: CardTextures;
  private readonly worldLayer = new Container();   // camera-transformed
  private readonly feltG = new Graphics();
  private readonly furniture = new Container();
  private readonly worldActors = new Container();
  private readonly screenActors = new Container();  // fixed (the hand)
  private readonly actors = new Map<string, CardActor>();
  private readonly controller = new CameraController();
  private state?: GameState;

  async mount(parent: HTMLElement): Promise<void> {
    this.app = new Application();
    await this.app.init({
      background: RAIL, antialias: true, resizeTo: parent,
      resolution: window.devicePixelRatio || 1, autoDensity: true,
    });
    parent.appendChild(this.app.canvas);
    this.textures = new CardTextures(this.app.renderer);

    this.worldLayer.addChild(this.feltG, this.furniture, this.worldActors);
    this.app.stage.addChild(this.worldLayer, this.screenActors);
    setActiveScene(this);
  }

  private get size(): Size {
    return { w: this.app.screen.width, h: this.app.screen.height };
  }

  /** Diff the actor set against a fresh layout of `state`; create/place/retire,
   *  route world vs screen actors to their layers, then draw the felt + furniture
   *  and cut the camera to its current preset. */
  renderState(state: GameState): void {
    this.state = state;
    const placed = [...layoutWorld(state), ...layoutScreen(state, this.size)];
    const live = new Set<string>();
    const focusedId = this.focusedPlayerId(state);

    for (const p of placed) {
      live.add(p.key);
      const actor = this.ensureActor(p);
      const layer = p.space === 'screen' ? this.screenActors : this.worldActors;
      layer.addChild(actor.view);                  // re-parents + keeps z in list order
      actor.place(p.placement, true);
      actor.view.alpha = this.dimAlpha(p, focusedId);
    }

    for (const [key, actor] of this.actors) {
      if (!live.has(key)) { actor.destroy(); this.actors.delete(key); }
    }

    this.drawFelt();
    this.drawFurniture(state);
    this.controller.syncActive(seatOfPlayer(state, state.turn.activePlayerId));
    this.applyCamera();
  }

  private ensureActor(p: PlacedActor): CardActor {
    const tex = p.card !== undefined ? this.textures.face(p.card, 'table') : this.textures.faceDown();
    let actor = this.actors.get(p.key);
    if (actor === undefined) {
      actor = new CardActor(p.key, p.objectId, tex);
      this.actors.set(p.key, actor);
    } else {
      actor.setTexture(tex);
    }
    return actor;
  }

  /** The player id the camera is focused on, or undefined at the whole table. */
  private focusedPlayerId(state: GameState): Id | undefined {
    const view = this.controller.view();
    if (view.kind !== 'seat') return undefined;
    return seatLayouts(state)[view.seat]?.player.id;
  }

  /** Unfocused seats dim (design §7.3); the contested stack and your hand never do. */
  private dimAlpha(p: PlacedActor, focusedId: Id | undefined): number {
    if (focusedId === undefined || p.space === 'screen') return 1;
    if (p.placement.zone === 'stack') return 1;
    return p.placement.ownerId === focusedId ? 1 : DIM_ALPHA;
  }

  private applyCamera(): void {
    const preset = camera(this.controller.view(), this.size);
    this.worldLayer.scale.set(preset.scale);
    this.worldLayer.position.set(preset.x, preset.y);
    // preset.tilt is the T4 perspective concern; T1 cuts flat.
  }

  // ── camera controls (design §7.3) ────────────────────────────────────────

  focusSeat(display: number): void { this.controller.focus(seatView(display)); this.applyCamera(); }
  showTable(): void { this.controller.focus(TABLE_VIEW); this.applyCamera(); }
  releaseCamera(): void { this.controller.release(); this.applyCamera(); }

  /** Re-lay at the live viewport (window resize): world layout is viewport-free,
   *  so only the hand and the camera framing change — re-running renderState is
   *  the simplest correct path at our render envelope (design §2). */
  resize(): void {
    if (this.state !== undefined) this.renderState(this.state);
  }

  // ── felt + furniture ─────────────────────────────────────────────────────

  private drawFelt(): void {
    const g = this.feltG.clear();
    g.roundRect(0, 0, WORLD.w, WORLD.h, 36).fill(FELT);
    g.roundRect(6, 6, WORLD.w - 12, WORLD.h - 12, 30).stroke({ width: 10, color: FELT_EDGE, alpha: 0.9 });
    // quarter folds, stopping short of the edges (§7.2)
    g.moveTo(WORLD.w / 2, WORLD.h * 0.06).lineTo(WORLD.w / 2, WORLD.h * 0.94)
      .moveTo(WORLD.w * 0.06, WORLD.h / 2).lineTo(WORLD.w * 0.94, WORLD.h / 2)
      .stroke({ width: 2, color: 0x000000, alpha: 0.16 });
  }

  private drawFurniture(state: GameState): void {
    this.furniture.removeChildren();
    for (const seat of seatLayouts(state)) {
      this.drawLamplight(seat);
      this.drawPileFootprints(seat);
      this.drawNameplate(seat);
    }
  }

  private drawLamplight(seat: SeatLayout): void {
    const { x, y, r } = seat.lamplight;
    this.furniture.addChild(new Graphics().circle(x, y, r).fill({ color: 0xffe6ad, alpha: 0.05 }));
  }

  private drawPileFootprints(seat: SeatLayout): void {
    const w = 100, h = 140;   // matches PILE_SCALE card size in world.ts
    const zones: PileZone[] = ['library', 'graveyard', 'exile', 'command'];
    for (const zone of zones) {
      const a = seat.piles[zone];
      // Exile gets a cold, drained footprint so "gone" reads apart from "dead" (§8).
      const cold = zone === 'exile';
      this.furniture.addChild(
        new Graphics()
          .roundRect(a.x - w / 2, a.y - h / 2, w, h, 8)
          .fill({ color: cold ? 0x243642 : 0x000000, alpha: cold ? 0.16 : 0.12 })
          .stroke({ width: 1.5, color: cold ? 0x486070 : 0x000000, alpha: 0.28 }),
      );
    }
  }

  private drawNameplate(seat: SeatLayout): void {
    const n = NAMEPLATE;
    const p = seat.player;
    const box = seat.nameplate;
    const plate = new Container();
    plate.position.set(box.x, box.y);
    plate.addChild(
      new Graphics().roundRect(0, 0, n.w, n.h, 7).fill(BRASS_FILL).stroke({ width: 1.5, color: BRASS }),
    );
    const dead = p.flags?.dead === true || p.flags?.left === true;
    plate.addChild(new Text({
      text: `${p.name}`,
      style: new TextStyle({ fontFamily: 'Georgia, serif', fontSize: 22, fill: dead ? 0x8a8375 : INK, fontWeight: '600' }),
    })).position.set(12, 9);
    const life = new Text({
      text: `${p.life}`,
      style: new TextStyle({ fontFamily: 'Georgia, serif', fontSize: 22, fill: INK, fontWeight: '700' }),
    });
    life.anchor.set(1, 0);
    life.position.set(n.w - 12, 9);
    plate.addChild(life);
    this.furniture.addChild(plate);
  }

  /** §12 scene accessor — real actor positions + the live camera for the harness. */
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
    const view = this.controller.view();
    const preset = camera(view, this.size);
    return {
      actors, animating,
      camera: {
        view: view.kind === 'table' ? 'table' : `seat:${view.seat}`,
        x: preset.x, y: preset.y, scale: preset.scale,
      },
    };
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
