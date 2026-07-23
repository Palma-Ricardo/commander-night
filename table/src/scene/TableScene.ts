// TableScene — owns the single Pixi Application, the flat scene of CardActors
// (design §6.1), the camera rig (§7.3), and the director (§6.3). T2 makes the
// table move: instead of snapping actors to a fresh layout, the scene hands each
// (state, events) step to the director, which drives it as a timed transition and
// only then advances `presented`. The scene is the director's `DirectorSink` — it
// turns a transition into actor tweens (survivors ease between layouts, new
// actors fly in from the zone their `move` event names, cards crossing the
// world↔screen seam are re-projected so they stay glued), and it runs the Pixi
// ticker that advances every tween + the interpolated camera each frame.
//
// Actors live in one flat layer, never inside a zone container, so a card is one
// persistent actor across hand ↔ battlefield ↔ graveyard ↔ exile (§3, §6.1): the
// same stable key appears in the before/after layouts, so the director tweens it
// rather than destroying and recreating it. The stack's ephemeral id is adopted
// onto that stable key via `stackLink` (scene/keys.ts), unifying cast → resolve.

import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { Card, GameEvent, GameState, Id, NightScene, SceneActor } from '@night/core';
import { CardActor } from '../render/CardActor';
import { CardTextures } from '../render/textures';
import { NAMEPLATE, seatLayouts, WORLD, type PileZone, type SeatLayout } from '../layout/world';
import type { ActorSpace, PlacedActor, Point, Size, Transform } from '../layout/types';
import { camera, worldToScreen, screenToWorld, type CameraPreset } from '../camera/camera';
import { Director, type DirectorSink } from './Director';
import { layoutKeyed, type StackLinks } from './keys';

const RAIL = 0x0e0b08;      // the floor the table sits on
const FELT = 0x1f3a2e;
const FELT_EDGE = 0x14261d;
const BRASS = 0x8a6a3a;
const BRASS_FILL = 0x3a2f1c;
const INK = 0xe8d9b0;
const DIM_ALPHA = 0.72;

// Zones a newly-created actor can fly *in from* — the owner's pile/fan anchor, in
// world space. A draw comes from the library, an opponent's cast from their hand.
const ORIGIN_PILE: Record<string, PileZone> = {
  library: 'library', graveyard: 'graveyard', exile: 'exile', command: 'command',
};

export class TableScene implements DirectorSink {
  private app!: Application;
  private textures!: CardTextures;
  private director!: Director;
  private readonly worldLayer = new Container();   // camera-transformed
  private readonly feltG = new Graphics();
  private readonly furniture = new Container();
  private readonly worldActors = new Container();
  private readonly screenActors = new Container();  // fixed (the hand)
  private readonly actors = new Map<string, CardActor>();

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

    const reducedMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    this.director = new Director(this, { viewport: this.size, reducedMotion });
    this.app.ticker.add(t => this.director.tick(t.deltaMS));

    setActiveScene(this);
  }

  private get size(): Size {
    return { w: this.app.screen.width, h: this.app.screen.height };
  }

  /** Feed a fresh authoritative state + its advisory events to the director; it
   *  decides animate-vs-snap and drives the transition on the ticker (§6.3). */
  present(state: GameState, events: readonly GameEvent[] = []): void {
    this.director.present(state, events);
  }

  // ── DirectorSink: one timed transition into `to` (§6.3) ──────────────────────

  applyTransition(
    to: GameState,
    _from: GameState | undefined,
    events: readonly GameEvent[],
    duration: number,
    links: StackLinks,
  ): void {
    const size = this.size;
    const placed = layoutKeyed(to, size, links);
    const preset = this.director.cameraPreset();          // §6.2: camera at start
    const moveByObj = new Map<Id, Extract<GameEvent, { k: 'move' }>>();
    for (const e of events) if (e.k === 'move') moveByObj.set(e.objectId, e);

    const focusedId = this.focusedPlayerId(to);
    const live = new Set<string>();

    for (const [key, p] of placed) {
      live.add(key);
      let actor = this.actors.get(key);
      if (actor === undefined) {
        actor = this.createActor(key, p);
        this.actors.set(key, actor);
        this.layerFor(p.space).addChild(actor.view);
        actor.space = p.space;
        // Fly in from the zone the move names, else appear at the target.
        const origin = duration > 0 ? this.entryOrigin(p, moveByObj, to, preset) : undefined;
        actor.seedCurrent(origin ?? this.transformOf(p));
      } else {
        this.refreshTexture(actor, p);
        if (actor.space !== p.space) {
          if (duration > 0) this.reproject(actor, p.space, preset);   // keep it glued across the seam
          this.layerFor(p.space).addChild(actor.view);
          actor.space = p.space;
        } else {
          this.layerFor(p.space).addChild(actor.view);   // re-append keeps z in layout order
        }
      }
      if (duration > 0) actor.animateTo(p.placement, duration);
      else actor.snapTo(p.placement);
      actor.view.alpha = this.dimAlpha(p, focusedId);
    }

    for (const [key, actor] of this.actors) {
      if (!live.has(key)) { actor.destroy(); this.actors.delete(key); }
    }

    this.drawFelt();
    this.drawFurniture(to);
  }

  frame(dtMs: number, preset: CameraPreset): void {
    for (const a of this.actors.values()) a.update(dtMs);
    this.worldLayer.scale.set(preset.scale);
    this.worldLayer.position.set(preset.x, preset.y);
    // preset.tilt is the T4 perspective concern; T2 keeps the world flat.
  }

  // ── actor helpers ────────────────────────────────────────────────────────────

  private createActor(key: string, p: PlacedActor): CardActor {
    const tex = p.card !== undefined ? this.textures.face(p.card, 'table') : this.textures.faceDown();
    return new CardActor(key, p.objectId, tex);
  }

  private refreshTexture(actor: CardActor, p: PlacedActor): void {
    actor.setTexture(p.card !== undefined ? this.textures.face(p.card, 'table') : this.textures.faceDown());
  }

  private layerFor(space: ActorSpace): Container {
    return space === 'screen' ? this.screenActors : this.worldActors;
  }

  private transformOf(p: PlacedActor): Transform {
    return { x: p.placement.x, y: p.placement.y, rotation: p.placement.rotation, scale: p.placement.scale };
  }

  /** Convert an actor's live transform into the space it is moving to, so a card
   *  crossing the world↔screen seam (a cast lifting off the hand, a draw sliding
   *  into it) stays visually continuous through the reparent (design §6.2). */
  private reproject(actor: CardActor, to: ActorSpace, preset: CameraPreset): void {
    const p = actor.pos;
    if (to === 'world') {
      const w = screenToWorld(preset, p);
      actor.seedCurrent({ x: w.x, y: w.y, rotation: 0, scale: this.currentScale(actor) / preset.scale });
    } else {
      const s = worldToScreen(preset, p);
      actor.seedCurrent({ x: s.x, y: s.y, rotation: 0, scale: this.currentScale(actor) * preset.scale });
    }
  }

  private currentScale(actor: CardActor): number {
    return actor.view.scale.x;
  }

  /** Where a new actor should spawn: the owner's source-zone anchor named by its
   *  `move` event, in the actor's destination space. Undefined ⇒ appear at target. */
  private entryOrigin(
    p: PlacedActor, moveByObj: Map<Id, Extract<GameEvent, { k: 'move' }>>,
    to: GameState, preset: CameraPreset,
  ): Transform | undefined {
    const objId = p.objectId;
    const mv = objId !== undefined ? moveByObj.get(objId) : undefined;
    if (mv === undefined) return undefined;
    const world = this.zoneAnchorWorld(mv.from, p.placement.ownerId, to);
    if (world === undefined) return undefined;
    if (p.space === 'screen') {
      const s = worldToScreen(preset, world);
      return { x: s.x, y: s.y, rotation: 0, scale: p.placement.scale };
    }
    return { x: world.x, y: world.y, rotation: 0, scale: p.placement.scale };
  }

  private zoneAnchorWorld(zone: string, ownerId: Id | undefined, state: GameState): Point | undefined {
    if (ownerId === undefined) return undefined;
    const seat = seatLayouts(state).find(s => s.player.id === ownerId);
    if (seat === undefined) return undefined;
    const pile = ORIGIN_PILE[zone];
    if (pile !== undefined) return seat.piles[pile];
    if (zone === 'hand') return seat.handFan;
    if (zone === 'stack') return { x: WORLD.w / 2, y: WORLD.h / 2 };
    return undefined;
  }

  /** The player id the camera is focused on, or undefined at the whole table. */
  private focusedPlayerId(state: GameState): Id | undefined {
    const view = this.director.cameraView();
    if (view.kind !== 'seat') return undefined;
    return seatLayouts(state)[view.seat]?.player.id;
  }

  /** Unfocused seats dim (design §7.3); the contested stack and your hand never do. */
  private dimAlpha(p: PlacedActor, focusedId: Id | undefined): number {
    if (focusedId === undefined || p.space === 'screen') return 1;
    if (p.placement.zone === 'stack') return 1;
    return p.placement.ownerId === focusedId ? 1 : DIM_ALPHA;
  }

  // ── camera controls (design §7.3), delegated to the director ──────────────────

  focusSeat(display: number): void { this.director.focusSeat(display); }
  showTable(): void { this.director.showTable(); }
  releaseCamera(): void { this.director.releaseCamera(); }

  /** Re-lay at the live viewport (window resize): world layout is viewport-free,
   *  so only the hand and the camera framing change — snap the current presented
   *  state to the new viewport rather than enqueuing a spurious animated step. */
  resize(): void {
    if (this.director === undefined) return;
    this.director.setViewport(this.size);
    const presented = this.director.presented;
    if (presented !== undefined) {
      this.applyTransition(presented, presented, [], 0, new Map());
    }
  }

  // ── felt + furniture ─────────────────────────────────────────────────────────

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

  /** §12 scene accessor — real actor positions + the live camera for the harness.
   *  `animating` is the director's "board caught up" signal (§6.4). */
  scene(): NightScene {
    const actors: SceneActor[] = [];
    for (const a of this.actors.values()) {
      actors.push({
        key: a.key, objectId: a.objectId, zone: a.placement.zone, ownerId: a.placement.ownerId,
        x: a.pos.x, y: a.pos.y, faceUp: a.placement.faceUp, animating: a.animating,
      });
    }
    const view = this.director?.cameraView() ?? { kind: 'table' as const };
    const preset = this.director?.cameraPreset() ?? camera({ kind: 'table' }, this.size);
    return {
      actors,
      animating: this.director !== undefined && !this.director.settled,
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
