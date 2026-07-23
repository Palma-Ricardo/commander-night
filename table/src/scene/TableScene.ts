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
import type { FederatedPointerEvent, Texture } from 'pixi.js';
import type { Card, GameEvent, GameState, Id, NightScene, SceneActor, ScryfallResolver, Zone } from '@night/core';
import { affordanceFor, commanderDamageRows } from '@night/core/state/selectors';
import type { PromptStoreState } from '@night/core/stores/prompt';
import { CardActor } from '../render/CardActor';
import { CardTextures, type Tier } from '../render/textures';
import {
  NAMEPLATE, PILE_FOOTPRINT, PILE_LABEL, opponentHandHalfWidth, seatLayouts, WORLD,
  type PileZone, type SeatLayout,
} from '../layout/world';
import type { ActorSpace, PlacedActor, Point, Size, Transform } from '../layout/types';
import { camera, worldToScreen, screenToWorld, type CameraPreset, type CameraView } from '../camera/camera';
import { Director, type DirectorSink } from './Director';
import { layoutKeyed, type StackLinks } from './keys';
import { promptObjectIds } from './prompt-objects';
import {
  highlightForAffordance, isClickable, rectContains, screenAnchor, type ScreenAnchor,
} from './interaction';

const RAIL = 0x0e0b08;      // the floor the table sits on
const FELT = 0x1f3a2e;
const FELT_EDGE = 0x14261d;
const BRASS = 0x8a6a3a;
const BRASS_FILL = 0x3a2f1c;
const INK = 0xe8d9b0;
const DIM_ALPHA = 0.72;
// Commander-damage plate chips (§6): a cold red pill per attacking commander.
const DMG_INK = 0xf0a89a;
const DMG_FILL = 0x2a100c;
const DMG_EDGE = 0x5e1f16;

// Zones a newly-created actor can fly *in from* — the owner's pile/fan anchor, in
// world space. A draw comes from the library, an opponent's cast from their hand.
const ORIGIN_PILE: Record<string, PileZone> = {
  library: 'library', graveyard: 'graveyard', exile: 'exile', command: 'command',
};

// Scryfall fetch priority by zone (§9): what you're looking at closest first.
const IMG_PRIORITY: Partial<Record<Zone, 0 | 1 | 2>> = {
  hand: 0, command: 0, battlefield: 1, stack: 1,
};
function imgPriority(zone: Zone): 0 | 1 | 2 { return IMG_PRIORITY[zone] ?? 2; }

// Battlefield permanents render as the T4 landscape art box; everything else stays
// a full portrait card (the hand, the stack, the piles, the hover preview).
function imgTier(zone: Zone): Tier { return zone === 'battlefield' ? 'artbox' : 'table'; }

export class TableScene implements DirectorSink {
  private app!: Application;
  private textures!: CardTextures;
  private director!: Director;
  private unsubResolver?: () => void;
  private readonly worldLayer = new Container();   // camera-transformed
  private readonly feltG = new Graphics();
  private readonly furniture = new Container();
  private readonly worldActors = new Container();
  private readonly screenActors = new Container();  // fixed (the hand)
  private readonly actors = new Map<string, CardActor>();

  // ── interaction (T3) ─────────────────────────────────────────────────────────
  /** The pending prompt + selection scratch, so the scene can derive board
   *  affordances (§7) exactly as the classic client's CardView does. */
  private currentPrompt: PromptStoreState | undefined;
  private lastPromptId: number | undefined;
  private lastViewKey = '';
  /** Raised on a semantic click / hover; the chrome (TableCanvas) wires these to
   *  the shared @night/core click router and the hover store, so the scene stays
   *  free of any React-chrome import. */
  onObjectClick?: (objectId: Id) => void;
  onObjectHover?: (objectId: Id | undefined, anchor?: ScreenAnchor) => void;
  /** Raised when the felt (an empty quadrant / a nameplate) is clicked — a manual
   *  camera focus (§7.3). */
  onFocusSeat?: (display: number) => void;
  /** Raised when the camera view or its follow-state changes, so the chrome's
   *  compass minimap + override badge (camera-store) can mirror where the lens
   *  points (§7.3). Fired from the frame loop, deduped on an actual change. */
  onCameraView?: (view: CameraView, following: boolean) => void;
  private lastCamSig = '';

  async mount(parent: HTMLElement, resolver: ScryfallResolver): Promise<void> {
    this.app = new Application();
    await this.app.init({
      background: RAIL, antialias: true, resizeTo: parent,
      resolution: window.devicePixelRatio || 1, autoDensity: true,
    });
    parent.appendChild(this.app.canvas);
    this.textures = new CardTextures(this.app.renderer, resolver);
    // A card's art resolves (store) then decodes (onArtReady), both after first
    // paint — swap it onto the live actors when either fires (§10 image fallback).
    this.textures.onArtReady = () => this.refreshAllTextures();
    this.unsubResolver = resolver.store.subscribe(() => this.refreshAllTextures());

    this.worldLayer.addChild(this.feltG, this.furniture, this.worldActors);
    this.app.stage.addChild(this.worldLayer, this.screenActors);

    // Empty felt is clickable → manual camera focus on that quadrant (§7.3). The
    // felt sits under the actors in z-order, so a card tap is picked first; only a
    // tap on bare cloth (or a nameplate, which falls through) reaches here.
    this.feltG.eventMode = 'static';
    this.feltG.on('pointertap', (e: FederatedPointerEvent) => this.handleFeltTap(e));

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
      actor.view.alpha = this.dimAlpha(p.space, p.placement.zone, p.placement.ownerId, focusedId);
    }

    for (const [key, actor] of this.actors) {
      if (!live.has(key)) { actor.destroy(); this.actors.delete(key); }
    }

    this.drawFelt();
    this.drawFurniture(to);
    this.refreshAffordances();   // newly-created actors need their §7 highlights
  }

  frame(dtMs: number, preset: CameraPreset): void {
    for (const a of this.actors.values()) a.update(dtMs);
    this.worldLayer.scale.set(preset.scale);
    this.worldLayer.position.set(preset.x, preset.y);
    // preset.tilt is the presentational lean (§7.3) — deferred: an affine container
    // squash distorts cards without reading as tilt; real perspective is the fix.
    // Re-dim only when the focused seat actually changed (a manual camera move
    // has no state transition to re-apply §7.3 dimming, so do it here).
    const key = this.cameraViewKey();
    if (key !== this.lastViewKey) { this.lastViewKey = key; this.redim(); }
    this.emitCameraView(key);
  }

  private cameraViewKey(): string {
    const v = this.director.cameraView();
    return v.kind === 'table' ? 'table' : `seat:${v.seat}`;
  }

  /** Push the live camera view + follow-state to the chrome when either changes
   *  (deduped on a combined signature — the frame loop runs every tick). */
  private emitCameraView(viewKey: string): void {
    const following = this.director.isFollowing();
    const sig = `${viewKey}|${following}`;
    if (sig === this.lastCamSig) return;
    this.lastCamSig = sig;
    this.onCameraView?.(this.director.cameraView(), following);
  }

  // ── actor helpers ────────────────────────────────────────────────────────────

  private createActor(key: string, p: PlacedActor): CardActor {
    const actor = new CardActor(key, p.objectId, this.textureFor(p));
    actor.card = p.card;
    // Every actor is hit-testable (§10: Pixi owns the table). Clicks route through
    // the pending prompt's affordance; hover previews any face-up card.
    actor.view.eventMode = 'static';
    actor.view.on('pointertap', () => this.handleActorTap(actor));
    actor.view.on('pointerover', () => this.handleActorOver(actor));
    actor.view.on('pointerout', () => this.handleActorOut(actor));
    return actor;
  }

  private refreshTexture(actor: CardActor, p: PlacedActor): void {
    actor.card = p.card;
    actor.setTexture(this.textureFor(p));
  }

  /** The texture for a placement: resolved art (or its text-frame placeholder) for
   *  a visible card, else the shared back. Honours `faceUp` so a face-down card
   *  never leaks its front, and requests art at the zone's priority (§9). */
  private textureFor(p: PlacedActor): Texture {
    if (p.card !== undefined && p.placement.faceUp) {
      const zone = p.placement.zone;
      return this.textures.face(p.card, imgTier(zone), imgPriority(zone));
    }
    return this.textures.faceDown();
  }

  /** Re-texture every live actor — the swap path for art that resolves/decodes
   *  after first paint (resolver store change or onArtReady). Idempotent: face()
   *  returns the same cached texture until the art is ready. */
  private refreshAllTextures(): void {
    for (const a of this.actors.values()) {
      if (a.card !== undefined && a.placement.faceUp) {
        const zone = a.placement.zone;
        a.setTexture(this.textures.face(a.card, imgTier(zone), imgPriority(zone)));
      }
    }
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
  private dimAlpha(space: ActorSpace, zone: Zone, ownerId: Id | undefined, focusedId: Id | undefined): number {
    if (focusedId === undefined || space === 'screen') return 1;
    if (zone === 'stack') return 1;
    return ownerId === focusedId ? 1 : DIM_ALPHA;
  }

  /** Re-apply §7.3 dimming to every actor for the current camera focus. Called on
   *  a camera-view change (which carries no state transition to re-dim through). */
  private redim(): void {
    const state = this.director.presented;
    if (state === undefined) return;
    const focusedId = this.focusedPlayerId(state);
    for (const a of this.actors.values()) {
      a.view.alpha = this.dimAlpha(a.space, a.placement.zone, a.placement.ownerId, focusedId);
    }
  }

  // ── interaction (T3): affordances, hit-testing, hover, prompt-driven camera ────

  /** Feed the pending prompt (+ selection scratch) so the board can highlight
   *  candidates and route clicks (§7). On a *new* prompt for this seat, catch the
   *  board up under the §6.4 budget so affordances are actionable, then run the
   *  §14 pull-back if a named object is off-screen under a manual pin. */
  setPrompt(prompt: PromptStoreState | undefined): void {
    const newId = prompt?.pending?.promptId;
    const changed = newId !== this.lastPromptId;
    this.currentPrompt = prompt;
    this.refreshAffordances();
    if (changed && prompt?.pending !== undefined) {
      this.director.flush();          // §6.4: input never waits on animation
      this.pullBackForPrompt(prompt); // §14: keep the asked-about objects in shot
    }
    this.lastPromptId = newId;
  }

  /** Paint each actor's affordance ring and set its cursor (§7). Pure over the
   *  stored prompt + the live actors, so it is safe to call on every prompt or
   *  transition change. */
  private refreshAffordances(): void {
    const prompt = this.currentPrompt;
    for (const a of this.actors.values()) {
      const aff = prompt !== undefined && a.objectId !== undefined
        ? affordanceFor(prompt, a.objectId) : undefined;
      a.setHighlight(highlightForAffordance(aff));
      a.view.cursor = isClickable(aff) ? 'pointer' : 'default';
    }
  }

  private handleActorTap(actor: CardActor): void {
    if (actor.objectId !== undefined) this.onObjectClick?.(actor.objectId);
  }

  private handleActorOver(actor: CardActor): void {
    if (actor.objectId !== undefined && actor.placement.faceUp) {
      this.onObjectHover?.(actor.objectId, this.actorAnchor(actor));
    }
  }

  private handleActorOut(_actor: CardActor): void {
    this.onObjectHover?.(undefined);
  }

  /** The on-screen rect of an actor's card face, for anchoring a DOM hover
   *  preview (§10 sceneToScreen). Composes layout with the live camera preset;
   *  world actors project through it, the screen-space hand does not. */
  private actorAnchor(actor: CardActor): ScreenAnchor {
    return screenAnchor(actor.space, actor.pos, actor.placement.scale, this.director.cameraPreset());
  }

  private handleFeltTap(e: FederatedPointerEvent): void {
    const state = this.director.presented;
    if (state === undefined) return;
    const local = e.getLocalPosition(this.worldLayer);   // world coords
    const seat = seatLayouts(state).findIndex(s => rectContains(s.quadrant, local));
    if (seat >= 0) (this.onFocusSeat ?? ((d: number) => this.director.focusSeat(d)))(seat);
  }

  /** §14: pull back to the whole table if a card the prompt names sits off-screen
   *  under the current (manual) camera. Screen-space objects (your hand) are
   *  always visible, so only world actors contribute points. */
  private pullBackForPrompt(prompt: PromptStoreState): void {
    const ids = new Set(promptObjectIds(prompt));
    if (ids.size === 0) return;
    const pts: Point[] = [];
    for (const a of this.actors.values()) {
      if (a.objectId !== undefined && a.space === 'world' && ids.has(a.objectId)) {
        pts.push({ x: a.placement.x, y: a.placement.y });
      }
    }
    this.director.ensureVisible(pts);
  }

  // ── camera controls (design §7.3), delegated to the director ──────────────────

  focusSeat(display: number): void { this.director.focusSeat(display); }
  showTable(): void { this.director.showTable(); }
  releaseCamera(): void { this.director.releaseCamera(); }

  /** The log panel's current intrusion from the right edge (0 when collapsed), so
   *  the camera frames the felt clear of it (§8). Called by the chrome on layout. */
  setLogInset(px: number): void { this.director?.setRightInset(px); }

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
      this.drawPiles(seat);
      this.drawNameplate(seat, state);
      this.drawHandCount(seat, state.me.playerId);
    }
  }

  private drawLamplight(seat: SeatLayout): void {
    const { x, y, r } = seat.lamplight;
    this.furniture.addChild(new Graphics().circle(x, y, r).fill({ color: 0xffe6ad, alpha: 0.05 }));
  }

  /** Each seat's pile column (§7.2 ".zones"): a footprint under the real card
   *  stack plus a count label, so a 1-card graveyard reads apart from an 18-card
   *  one. Empty zones are a faint outline (not a solid block that mimics a card);
   *  exile stays cold so "gone" never reads as "dead" (§8). */
  private drawPiles(seat: SeatLayout): void {
    const { w, h } = PILE_FOOTPRINT;
    const p = seat.player;
    const counts: Record<PileZone, number> = {
      library: p.librarySize, graveyard: p.graveyard.length,
      exile: p.exile.length, command: p.commandZone.length,
    };
    for (const zone of ['library', 'graveyard', 'exile', 'command'] as PileZone[]) {
      const a = seat.piles[zone];
      const count = counts[zone];
      const cold = zone === 'exile';
      const g = new Graphics().roundRect(a.x - w / 2, a.y - h / 2, w, h, 6);
      if (count === 0) g.stroke({ width: 1.5, color: cold ? 0x486070 : 0x000000, alpha: 0.3 });
      else g.fill({ color: cold ? 0x121d24 : 0x000000, alpha: cold ? 0.42 : 0.3 });
      this.furniture.addChild(g);

      // The command zone is always 1–2 (the commander), so a count there is noise —
      // the zone tag alone. Every other pile carries its size.
      const label = new Text({
        text: zone === 'command' ? PILE_LABEL[zone] : `${PILE_LABEL[zone]} ${count}`,
        style: new TextStyle({
          fontFamily: 'ui-monospace, monospace', fontSize: 15, letterSpacing: 1,
          fill: count === 0 ? 0x6c7871 : 0xa6b0a9, fontWeight: '600',
        }),
      });
      label.anchor.set(0.5, 0);
      label.position.set(a.x, a.y + h / 2 + 6);
      this.furniture.addChild(label);
    }
  }

  /** The public count of an opponent's held hand, beside their back-fan (§7.2
   *  ".held-n"). My own hand is the screen-space fan, so it carries no count here. */
  private drawHandCount(seat: SeatLayout, meId: Id): void {
    const p = seat.player;
    if (p.id === meId || p.handSize === 0) return;
    const side = seat.corner.left ? 1 : -1;   // the glyph sits inboard of the fan
    const label = new Text({
      text: `${p.handSize}`,
      style: new TextStyle({ fontFamily: 'ui-monospace, monospace', fontSize: 16, fill: 0x8b95a0, fontWeight: '700' }),
    });
    label.anchor.set(side === 1 ? 0 : 1, 0.5);
    label.position.set(seat.handFan.x + side * (opponentHandHalfWidth(p.handSize) + 10), seat.handFan.y);
    this.furniture.addChild(label);
  }

  private drawNameplate(seat: SeatLayout, state: GameState): void {
    const n = NAMEPLATE;
    const p = seat.player;
    const box = seat.nameplate;
    const plate = new Container();
    plate.position.set(box.x, box.y);
    plate.addChild(
      new Graphics().roundRect(0, 0, n.w, n.h, 7).fill(BRASS_FILL).stroke({ width: 1.5, color: BRASS }),
    );
    const dead = p.flags?.dead === true || p.flags?.left === true;
    const name = new Text({
      text: `${p.name}`,
      style: new TextStyle({ fontFamily: 'Georgia, serif', fontSize: 22, fill: dead ? 0x8a8375 : INK, fontWeight: '600' }),
    });
    name.anchor.set(0, 0.5);                 // centre in the taller plate, not top-pinned
    name.position.set(12, n.h / 2);
    plate.addChild(name);
    const life = new Text({
      text: `${p.life}`,
      style: new TextStyle({ fontFamily: 'Georgia, serif', fontSize: 22, fill: INK, fontWeight: '700' }),
    });
    life.anchor.set(1, 0.5);
    life.position.set(n.w - 12, n.h / 2);
    plate.addChild(life);
    this.drawCommanderDamage(plate, commanderDamageRows(state, p));
    this.furniture.addChild(plate);
  }

  /** Commander-damage chips (§6), one per attacking commander, in a strip to the
   *  right of the plate — a red pill of "⚔ <commander> N" so lethal (21) creeps
   *  up where the victim reads it, without tracing a combat arrow. */
  private drawCommanderDamage(plate: Container, rows: { commander: string; amount: number }[]): void {
    let x = NAMEPLATE.w + 8;
    const h = 22;
    for (const row of rows) {
      const short = (row.commander.split(/[ ,]/)[0] ?? row.commander).slice(0, 6);
      const chip = new Container();
      const text = new Text({
        text: `⚔ ${short} ${row.amount}`,
        style: new TextStyle({ fontFamily: 'ui-monospace, monospace', fontSize: 14, fill: DMG_INK, fontWeight: '700' }),
      });
      const w = Math.round(text.width) + 12;
      chip.position.set(x, NAMEPLATE.h / 2 - h / 2);
      chip.addChild(new Graphics().roundRect(0, 0, w, h, 4).fill(DMG_FILL).stroke({ width: 1, color: DMG_EDGE }));
      text.anchor.set(0, 0.5);
      text.position.set(6, h / 2);
      chip.addChild(text);
      plate.addChild(chip);
      x += w + 5;
    }
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
    this.unsubResolver?.();
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
