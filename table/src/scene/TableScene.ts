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

import { Application, Container, Graphics, PerspectiveMesh, Rectangle, Text, Texture, TextStyle } from 'pixi.js';
import type { FederatedPointerEvent } from 'pixi.js';
import type {
  Card, GameEvent, GameState, Id, NightScene, Phase, SceneActor, ScryfallResolver, Step, Verb, Zone,
} from '@night/core';
import { affordanceFor, commanderDamageRows } from '@night/core/state/selectors';
import type { PromptStoreState } from '@night/core/stores/prompt';
import { CardActor, LUNGE_IMPACT_AT } from '../render/CardActor';
import { CardTextures, identityColor, type Tier } from '../render/textures';
import { Effects } from '../render/Effects';
import {
  NAMEPLATE, PILE_FOOTPRINT, PILE_LABEL, opponentHandHalfWidth, seatLayouts, WORLD,
  type PileZone, type SeatLayout,
} from '../layout/world';
import type { ActorSpace, PlacedActor, Point, Rect, Size, Transform } from '../layout/types';
import {
  camera, worldToScreen, screenToWorld, depthScaleAt, type CameraPreset, type CameraView,
} from '../camera/camera';
import { Director, type DirectorSink } from './Director';
import { layoutKeyed, type StackLinks } from './keys';
import { CAST_THRESHOLD, DRAG_HOME_MS, DRAG_SLOP_PX, PAGE_TURN_MS } from '../tuning';
import { handPageCount, stackAnchor } from '../layout/screen';
import {
  carouselContent, carouselPageCount, layoutCarouselFan, type BrowseZone, type CarouselEntry,
} from '../layout/carousel';
import { carouselStore, pageFor, turnPage } from './carousel-store';
import { promptObjectIds, stackTargetIds } from './prompt-objects';
import {
  highlightForAffordance, HL_COMBAT, HL_TARGET, isClickable, rectContains,
  type Projector, type ScreenAnchor,
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

// Player-counter chips (#26): the common counters get a glyph; anything else
// shows its own name. Poison renders in the danger tone (10 = dead).
const COUNTER_ICON: Record<string, string> = {
  poison: '☠ poison', energy: '⚡ energy', experience: '✦ xp',
};
interface SeatChip { label: string; tone: 'danger' | 'note' }
const HAND_RECENTRE_MS = 200;   // the fan slides (not snaps) when the log opens/closes
const HOVER_GRACE_MS = 140;     // let the pointer cross the gap from a card to its preview
const TETHER_TARGET = 0xff5647;  // a stack item points at its target (aggressive red)
const TETHER_SOURCE = 0xbfd0ff;  // fallback source-arrow tint when identity is unknown

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

// Battlefield permanents render as the T4 landscape art box; the stack's front
// card is drawn very large so it takes full-res `detail` art (like the hover
// preview); the hand and piles stay small table-tier portraits.
function imgTier(zone: Zone): Tier {
  if (zone === 'battlefield') return 'artbox';
  if (zone === 'stack') return 'detail';
  return 'table';
}

// A furniture shape in world coords, drawn each frame as a projected quad so it
// keystones with the felt (T4): the pile footprints, nameplate plates, chip boxes.
interface FurnitureShape {
  rect: Rect;
  fill?: { color: number; alpha: number };
  stroke?: { width: number; color: number; alpha: number };
}

export class TableScene implements DirectorSink {
  private app!: Application;
  private textures!: CardTextures;
  private director!: Director;
  private unsubResolver?: () => void;
  private readonly worldLayer = new Container();   // identity: children are placed in screen space
  private feltMesh!: PerspectiveMesh;               // the felt surface, keystoned per frame (T4)
  private feltTex?: Texture;                        // baked felt base (rect + folds + lamplight)
  private feltSig = '';                             // rebuilds the felt tex only when the layout moves
  // Furniture keystones geometrically (§7): the footprint / nameplate / chip
  // *shapes* are drawn as projected quads into one Graphics every frame, so they
  // lean with the felt; their text labels billboard upright at the projected anchor
  // (the same pattern as a card's P/T chrome) so they stay legible. The specs are
  // rebuilt only on a state transition; the projection runs each frame.
  private readonly furnitureShapes = new Graphics();
  private readonly furnitureText = new Container();
  private shapeSpecs: FurnitureShape[] = [];
  private textItems: { node: Text; anchor: Point }[] = [];
  private readonly worldActors = new Container();
  private readonly screenActors = new Container();  // fixed (the hand + the stack pile)
  private readonly actors = new Map<string, CardActor>();
  // The carousel browser (prompts-on-the-table §4.4): a screen-space fan above
  // the hand, its own actor map — its cards are not part of the keyframe layout
  // (a library look's cards exist nowhere else), so the director's diff never
  // touches them. Synced from prompt/state/store changes by syncCarousel.
  private readonly carouselLayer = new Container();
  // The newest authoritative state, ahead of the director's presented one. The
  // carousel is a prompt surface, and prompt surfaces render against
  // authoritative state (design §6.4) — deriving from `presented` opened a
  // phantom placeholder fan whenever an ask's candidates were still animating
  // in (Windfall: draw seven, "select a card to discard" beats the draws;
  // live-caught at the 2026-07-26 night, Issues.txt #1). The DOM bar and the
  // shortcuts already read the store's state; this keeps the scene agreeing.
  private latestState: GameState | undefined;
  private readonly carouselActors = new Map<string, CardActor>();
  private carouselKey: string | undefined;          // last content identity, for open/turn juice
  private unsubCarousel?: () => void;
  private lastHandPage = -1;
  // Stack tethers (T4 §9): the source + target arrows of the top-of-stack item.
  // A screen-space overlay under the cards, redrawn every frame so the arrows
  // track the camera as their felt endpoints keystone across the seam. The links
  // (ephemeral stackId → source objectId) and the top item's actor key are cached
  // from the last transition so the per-frame redraw stays cheap.
  private readonly stackTethers = new Graphics();
  private stackLinks: StackLinks = new Map();
  private topStackKey: string | undefined;
  // The live pointer-to-target chalk line (prompts-on-the-table §4.2): redrawn
  // every frame while a point-mode drag is moved, from the subject's projected
  // centre to the pointer. Same screen-space overlay slot as the stack tethers.
  private readonly dragLine = new Graphics();
  // §9 transient effects (dust, damage, arrows, ribbons, ghosts, vignette, shake).
  private readonly effects = new Effects();
  // Delayed one-shots (landing squash/dust fire on arrival, not takeoff): advanced
  // in the frame loop, re-resolving actors by id so a replaced actor is a no-op.
  private timers: { left: number; fn: () => void }[] = [];
  private reducedMotion = false;

  // ── interaction (T3) ─────────────────────────────────────────────────────────
  /** The pending prompt + selection scratch, so the scene can derive board
   *  affordances (§7) exactly as the classic client's CardView does. */
  private currentPrompt: PromptStoreState | undefined;
  private lastPromptId: number | undefined;
  private lastViewKey = '';
  /** Hover is two independent lifecycles, both driven by the live pointer so the
   *  scene — not Pixi's movement-only pointerout, and not a DOM timer — is the sole
   *  authority (that split is what let the preview get stuck):
   *   • `hoveredKey`: the HAND card currently raised in place to read it (no panel).
   *   • `previewActorKey` + `previewGrace`: the corner preview shown for any OTHER
   *     face-up card. It persists only while the pointer is over that card or over
   *     the preview panel's own rect (`getPreviewRect`), with a short grace to cross
   *     the gap between them; otherwise the grace runs out and it hides. */
  private hoveredKey: string | undefined;
  private previewActorKey: string | undefined;
  private previewGrace = 0;
  private pointer: Point | undefined;
  private detachPointer?: () => void;
  /** The armed drag, two modes (prompts-on-the-table §9 / §4.2):
   *   • 'cast' — a press on a castable hand card; past DRAG_SLOP_PX the card
   *     lifts and follows the pointer, and the release side of CAST_THRESHOLD
   *     decides cast vs slide home.
   *   • 'point' — pointer-to-target: the subject stays put, a chalk line (in
   *     `color`) follows the pointer, and the release resolves a drop target
   *     for pointTarget / the §4.3 intent buffer. */
  private drag?: {
    mode: 'cast' | 'point'; color: number;
    key: string; objectId: Id; startX: number; startY: number; moved: boolean;
  };
  /** Pixi still fires `pointertap` after a moved drag (the card follows the
   *  pointer, so down and up land on the same object) — the release handler
   *  raises this so handleActorTap ignores exactly that one tap. */
  private dragSwallowsTap = false;
  /** True while the pending prompt targets a stack item (counter/copy/redirect):
   *  the pile un-fans into a clickable row so buried candidates are reachable (§7 T4). */
  private spreadStack = false;
  // Candidate ids un-folded from board piles while a multi-target ask runs (#24).
  private spreadBoard: ReadonlySet<Id> = new Set();
  /** px the open log sidebar steals from the right (§8): the world is framed clear
   *  of it by the camera's own inset, and the hand fan re-centres in the felt that
   *  is left. Kept here so every layout (transition + recentre) uses one value. */
  private rightInset = 0;
  /** Raised on a semantic click / hover; the chrome (TableCanvas) wires these to
   *  the shared @night/core click router and the hover store, so the scene stays
   *  free of any React-chrome import. */
  onObjectClick?: (objectId: Id) => void;
  /** A point-mode drag released on `objectId` (§4.2/§4.3) — the chrome wires
   *  this to actions.pointTarget: an immediate target click when the matching
   *  chooseTargets is already pending, else the buffered intent. */
  onPointTarget?: (objectId: Id) => void;
  onObjectHover?: (objectId: Id | undefined, anchor?: ScreenAnchor) => void;
  /** A click on a graveyard/exile pile (its top card or its footprint) that no
   *  prompt affordance consumed — the chrome wires this to the §4.4 browse fan. */
  onPileOpen?: (playerId: Id, zone: BrowseZone) => void;
  /** Reads the hover preview panel's current on-screen rect (chrome-owned), so the
   *  scene can hold the preview open while the pointer is over the panel itself. */
  getPreviewRect?: () => ScreenAnchor | undefined;
  /** Wheel-zoom the open hover preview (#13); returns whether it consumed the
   *  gesture (false = no preview open, so the wheel falls through to the carousel
   *  pager). Chrome-owned like the rest of the preview. */
  onZoomPreview?: (delta: number) => boolean;
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
    // Face-down cards (the library stack, opponents' hand fans, morphs) show the
    // real card back (§7.2): preload it so `faceDown()` returns the art from first
    // paint rather than the procedural back that would pop a frame later.
    await this.textures.loadCardBack();

    // The felt is a PerspectiveMesh: a baked felt texture mapped onto the four
    // projected world corners each frame, so the whole surface keystones (T4). A
    // fine vertex grid keeps the felt's gradients smooth under the projection.
    this.feltMesh = new PerspectiveMesh({ texture: Texture.WHITE, verticesX: 20, verticesY: 20 });
    // Furniture shapes + text draw above the felt, below the cards; neither eats
    // pointer events so a tap on bare felt still reaches the felt mesh below.
    this.furnitureShapes.eventMode = 'none';
    this.furnitureText.eventMode = 'none';
    this.stackTethers.eventMode = 'none';   // arrows never eat a click
    this.dragLine.eventMode = 'none';
    // Effects: worldFx keystones among the actors (it self-projects), screenFx is a
    // fixed overlay on top of everything (vignette, phase ribbon).
    this.worldLayer.addChild(this.feltMesh, this.furnitureShapes, this.furnitureText,
      this.worldActors, this.effects.worldFx);
    // Tethers sit above the felt/world actors (so an arrowhead lands visibly on a
    // target permanent) but below the screen cards (so the pile stays readable and
    // the arrow reads as emerging from beneath the top card).
    // The carousel fan reads above the hand/stack (it is the active surface when
    // open) but below the fixed screen effects (vignette, ribbon).
    this.app.stage.addChild(this.worldLayer, this.stackTethers, this.dragLine, this.screenActors,
      this.carouselLayer, this.effects.screenFx);

    // Empty felt is clickable → manual camera focus on that quadrant (§7.3). The
    // felt sits under the actors in z-order, so a card tap is picked first; only a
    // tap on bare cloth (or a nameplate, which falls through) reaches here.
    this.feltMesh.eventMode = 'static';
    this.feltMesh.on('pointertap', (e: FederatedPointerEvent) => this.handleFeltTap(e));

    const reducedMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    this.reducedMotion = reducedMotion;
    this.director = new Director(this, { viewport: this.size, reducedMotion });
    this.app.ticker.add(t => this.director.tick(t.deltaMS));

    // Track the pointer in the renderer's own (screen) coords — the space actor
    // bounds() report in — so the per-frame hover backstop can hit-test against it.
    // Leaving the canvas dismisses any hover; the DOM preview holds itself open if
    // the pointer crossed onto it (hover.ts grace).
    const canvas = this.app.canvas;
    const onMove = (e: PointerEvent): void => {
      const r = canvas.getBoundingClientRect();
      this.pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    // Pointer left the canvas entirely (to the log panel, off-window). Clearing the
    // tracked position makes the next verifyHover drop both the lift and the preview.
    const onLeave = (): void => { this.pointer = undefined; };
    // The drag release listens on window, not the canvas — a card dragged past
    // the viewport edge must still cast or come home, never strand mid-air.
    const onUp = (e: PointerEvent): void => this.endDrag(e);
    const onCancel = (): void => this.cancelDrag();
    // Wheel pages the open carousel (§4.4: wheel/arrows/edge buttons, never
    // vertical scroll). Closed ⇒ the wheel does nothing, as before.
    const onWheel = (e: WheelEvent): void => this.handleWheel(e);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    this.detachPointer = () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };

    // The fan re-syncs on any UI-store change (browse open/close, filter, page);
    // a hand-page change re-lays the screen layer like a log-inset move (§4.4).
    this.unsubCarousel = carouselStore.subscribe(s => {
      if (s.handPage !== this.lastHandPage) {
        this.lastHandPage = s.handPage;
        this.relayScreen(PAGE_TURN_MS);
      }
      this.syncCarousel();
    });

    setActiveScene(this);
  }

  private get size(): Size {
    return { w: this.app.screen.width, h: this.app.screen.height };
  }

  /** Feed a fresh authoritative state + its advisory events to the director; it
   *  decides animate-vs-snap and drives the transition on the ticker (§6.3). */
  present(state: GameState, events: readonly GameEvent[] = []): void {
    this.latestState = state;
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
    const placed = layoutKeyed(to, size, links, this.rightInset, this.spreadStack, this.handPageNow(to),
      this.spreadBoard);
    const preset = this.director.cameraPreset();          // §6.2: camera at start
    const moveByObj = new Map<Id, Extract<GameEvent, { k: 'move' }>>();
    for (const e of events) if (e.k === 'move') moveByObj.set(e.objectId, e);

    // Cache what the per-frame tether redraw needs: the stackLink bindings and the
    // actor key of the top-of-stack item (matched by its card view id, which is the
    // one field adoption leaves untouched on the placed stack actor).
    this.stackLinks = links;
    this.topStackKey = undefined;
    const topItem = to.stack[to.stack.length - 1];
    if (topItem !== undefined) {
      for (const [key, pp] of placed) {
        if (pp.placement.zone === 'stack' && pp.objectId === topItem.card?.id) { this.topStackKey = key; break; }
      }
    }

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
      if (duration > 0) {
        const mv = p.objectId !== undefined ? moveByObj.get(p.objectId) : undefined;
        actor.animateTo(p.placement, duration, arcForMove(mv?.verb, p.space, mv?.to));
      } else {
        actor.snapTo(p.placement);
      }
      actor.view.alpha = this.dimAlpha(p.space, p.placement.zone, p.placement.ownerId, focusedId);
    }

    for (const [key, actor] of this.actors) {
      if (!live.has(key)) { actor.destroy(); this.actors.delete(key); }
    }

    // Keep a hovered hand card raised to the front through the transition — the
    // placement loop just re-appended every actor in natural fan order.
    if (this.hoveredKey !== undefined) {
      const hv = this.actors.get(this.hoveredKey);
      if (hv !== undefined && hv.space === 'screen') this.screenActors.addChild(hv.view);
    }

    this.rebuildFelt(to);
    this.drawFurniture(to);
    this.refreshAffordances();   // newly-created actors need their §7 highlights
    this.syncCarousel();         // browse contents live-update; prompt fans re-lay
    this.syncCameraFocus(to);    // §14: widen for a cross-board stack target, no prompt needed
    this.announcePhase(events);  // outside the juice gate on purpose — see below
    if (duration > 0 && !this.reducedMotion) this.playJuice(to, events, duration, preset);
    this.paint(preset);          // project felt + furniture + actors now, so nothing flashes unplaced
  }

  frame(dtMs: number, preset: CameraPreset): void {
    for (const a of this.actors.values()) a.update(dtMs);
    for (const a of this.carouselActors.values()) a.update(dtMs);
    this.updateDrag();   // the drag pin wins over any tween this frame (§9 drag-to-cast)
    this.advanceTimers(dtMs);
    this.effects.update(dtMs);
    const shake = this.effects.shakeOffset();
    this.app.stage.position.set(shake.x, shake.y);
    this.paint(preset);
    this.verifyHover(dtMs);   // the scene's hover authority — never let a preview stick (§10)
    // Re-dim only when the focused seat actually changed (a manual camera move
    // has no state transition to re-apply §7.3 dimming, so do it here).
    const key = this.cameraViewKey();
    if (key !== this.lastViewKey) { this.lastViewKey = key; this.redim(); }
    this.emitCameraView(key);
  }

  /** Project everything to the screen for `preset` (T4): the felt mesh, the
   *  furniture (shapes as projected quads + text billboards), and every actor. The
   *  world has no container transform now — the perspective warp lives in the
   *  projection, so each object is re-placed per frame (worldLayer stays identity). */
  private paint(preset: CameraPreset): void {
    const world: Projector = {
      toScreen: p => worldToScreen(preset, p),
      scaleAt: p => preset.scale * depthScaleAt(preset, p),
    };
    const screen: Projector = { toScreen: p => p, scaleAt: () => 1 };
    this.updateFeltMesh(preset);
    this.projectFurniture(preset);
    for (const a of this.actors.values()) a.render(a.space === 'screen' ? screen : world);
    for (const a of this.carouselActors.values()) a.render(screen);
    this.drawStackTethers(preset);   // arrows read the actors' fresh projected bounds
    this.drawDragLine();             // the §4.2 chalk line tracks the same fresh bounds
    this.effects.render(world);   // effects live in world space (they self-project)
  }

  /** Map the felt texture onto the four projected world corners — the trapezoid
   *  that makes the table read as leaning back (T4). */
  private updateFeltMesh(preset: CameraPreset): void {
    const tl = worldToScreen(preset, { x: 0, y: 0 });
    const tr = worldToScreen(preset, { x: WORLD.w, y: 0 });
    const br = worldToScreen(preset, { x: WORLD.w, y: WORLD.h });
    const bl = worldToScreen(preset, { x: 0, y: WORLD.h });
    this.feltMesh.setCorners(tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y);
  }

  /** Redraw every furniture shape as a projected quad (so it keystones with the
   *  felt) and billboard each text label upright at its projected anchor, depth-
   *  scaled so far seats read smaller. Runs every frame — cheap over a few dozen
   *  shapes/labels. */
  private projectFurniture(preset: CameraPreset): void {
    const g = this.furnitureShapes.clear();
    for (const s of this.shapeSpecs) {
      const { x, y, w, h } = s.rect;
      const a = worldToScreen(preset, { x, y });
      const b = worldToScreen(preset, { x: x + w, y });
      const c = worldToScreen(preset, { x: x + w, y: y + h });
      const d = worldToScreen(preset, { x, y: y + h });
      const poly = [a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y];
      if (s.fill !== undefined) g.poly(poly).fill(s.fill);
      if (s.stroke !== undefined) {
        g.poly(poly).stroke({ ...s.stroke, width: Math.max(1, s.stroke.width * preset.scale) });
      }
    }
    for (const t of this.textItems) {
      const sp = worldToScreen(preset, t.anchor);
      t.node.position.set(sp.x, sp.y);
      t.node.scale.set(preset.scale * depthScaleAt(preset, t.anchor));
    }
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

  // ── §9 animation catalogue: events → juice ───────────────────────────────────

  /** Raise the phase ribbon for this transition (design §9 `step`).
   *
   *  Deliberately *not* part of `playJuice`: juice only plays for an animated step,
   *  but the director snaps at duration 0 whenever it catches up on a backlog
   *  (§6.3) or flushes for a fresh prompt (§6.4) — and getting priority in your
   *  precombat main is exactly a flush, so that banner was the one most reliably
   *  swallowed. The ribbon is an announcement, not motion, so it survives the cut.
   *  Effects coalesces, so a burst of phases in one tick shows only the newest. */
  private announcePhase(events: readonly GameEvent[]): void {
    if (this.reducedMotion) return;
    for (const e of events) {
      if (e.k === 'step' && e.phase !== undefined) {
        this.effects.phaseRibbon(phaseLabel(e.phase, e.step), this.size, this.rightInset);
      }
    }
  }

  /** Turn the advisory §7.1 events for this transition into motion + particles
   *  (design §9). Only called for an animated step (duration > 0, motion enabled) —
   *  a snap/first-paint/reduced-motion cut plays no juice, matching the director's
   *  "dropping animation is always legal". Card-attached juice (glow/flash/tip)
   *  rides the actor so it follows the card mid-flight; landing effects are delayed
   *  to arrival; particles are spawned into the effects layer at world anchors. */
  private playJuice(to: GameState, events: readonly GameEvent[], duration: number, preset: CameraPreset): void {
    const me = to.me?.playerId;
    // The stack now lives at the right edge in screen space; unproject its anchor so
    // a world-space trigger ghost/ribbon still flies to where the pile actually is.
    const stack = screenToWorld(preset, stackAnchor(this.size, this.rightInset));
    let untapIdx = 0;
    for (const e of events) {
      switch (e.k) {
        case 'move': this.moveJuice(e, duration, preset); break;
        case 'tap': {
          const actor = this.actorByObject(e.objectId);
          actor?.overshoot(0.14);
          if (e.forMana === true) {
            const from = this.worldPointOf(e.objectId);
            const pool = this.seatPoint(actor?.placement.ownerId, to);
            if (from !== undefined && pool !== undefined) {
              this.effects.manaPip(from, pool, actor?.card !== undefined ? identityColor(actor.card) : 0xffe6ad);
            }
          }
          break;
        }
        case 'untap': {
          const id = e.objectId;
          this.after(untapIdx++ * 45, () => this.actorByObject(id)?.overshoot(-0.14));   // ripple (§9)
          break;
        }
        case 'attack': {
          const target = this.seatPoint(e.defenderId, to) ?? this.worldPointOf(e.defenderId);
          for (const aid of e.attackerIds) {
            const from = this.worldPointOf(aid);
            if (from !== undefined && target !== undefined) this.effects.attackArrow(from, target);
          }
          break;
        }
        case 'block': {
          // The pair rims to a common colour (§9) while the layout slides the
          // blocker out to interpose and nudges the attacker back.
          this.actorByObject(e.attackerId, 'battlefield')?.sparkGlow(HL_COMBAT, duration + 300);
          for (const bid of e.blockerIds) {
            this.actorByObject(bid, 'battlefield')?.sparkGlow(HL_COMBAT, duration + 300);
          }
          break;
        }
        case 'damage': {
          const p = this.worldPointOf(e.targetId) ?? this.seatPoint(e.targetId, to);
          // Combat damage is delivered by a lunge (§9): whoever is punching the
          // target strikes there-and-back, and the flash/number/shake land at the
          // moment of the hit, not at takeoff. 0 ⇒ nobody lunged, fire at once.
          const hitDelay = e.combat ? this.lungeAt(e.targetId, to) : 0;
          this.after(hitDelay, () => {
            if (p !== undefined) {
              this.effects.damageNumber(p, e.amount, e.combat);
              this.effects.impactFlash(p);
            }
            this.actorByObject(e.targetId)?.sparkFlash();
            if (e.combat) this.effects.addShake(Math.min(18, 3 + e.amount * 1.4));
          });
          break;
        }
        case 'life': {
          const p = this.seatPoint(e.playerId, to);
          const delta = e.to - e.from;
          if (p !== undefined && delta !== 0) {
            this.effects.pip(p, `${delta > 0 ? '+' : ''}${delta}`, delta >= 0 ? 0x7bd88f : 0xff8a6a);
          }
          if (e.playerId === me && delta <= -5) this.effects.vignette(this.size, Math.min(1, -delta / 15));
          break;
        }
        case 'counters': {
          const p = this.worldPointOf(e.objectId);
          const d = e.to - e.from;
          if (p !== undefined && d !== 0) this.effects.pip(p, `${d > 0 ? '+' : ''}${d}`, 0xd9c98a);
          break;
        }
        case 'trigger': {
          const src = this.actorByObject(e.sourceId);
          const from = this.worldPointOf(e.sourceId);
          if (src !== undefined && from !== undefined) {
            const col = src.card !== undefined ? identityColor(src.card) : 0xffe6ad;
            src.sparkGlow(col);
            this.effects.triggerRibbon(from, stack, col);
            if (src.card !== undefined) {
              this.effects.ghost(this.textures.face(src.card, 'table', 1), from, stack, src.placement.scale * 0.9);
            }
          }
          break;
        }
        default: break;   // step (see announcePhase) / hidden / stackLink / reveal /
                          // shuffle / scry / search: no §9 motion
      }
    }
  }

  /** The per-verb read of a zone move (design §9 catalogue rows). Runs after the
   *  placement loop, so the actor already targets its destination (`e.to`) while
   *  its *current* position is still where the move starts. */
  private moveJuice(e: Extract<GameEvent, { k: 'move' }>, duration: number, preset: CameraPreset): void {
    const actor = this.actorByObject(e.objectId, e.to);
    const card = actor?.card;
    const land = this.worldPointOf(e.objectId);
    switch (e.verb) {
      case 'cast':
        // Glow by colour identity for the whole flight plus a beat on the stack —
        // a decay that starts at takeoff is spent before anyone sees it.
        if (actor !== undefined && card !== undefined) {
          actor.sparkGlow(identityColor(card), duration + 400);
        }
        break;
      case 'resolve':
        if (land !== undefined) this.after(duration, () => {
          this.actorByObject(e.objectId, e.to)?.land(1);
          this.effects.dustRing(land, 1);
        });
        break;
      case 'play':
        if (land !== undefined) this.after(duration, () => {
          this.actorByObject(e.objectId, e.to)?.land(0.6);
          this.effects.dustRing(land, 0.7);
        });
        break;
      case 'token':
        if (land !== undefined) this.after(duration, () => {
          this.actorByObject(e.objectId, e.to)?.land(0.5);
          this.effects.dustRing(land, 0.6);
        });
        break;
      case 'destroy':
        actor?.die();
        this.reviveAfter(e.objectId, duration);
        break;
      case 'sacrifice': {
        // A different read from destroy (§9): a brief self-consuming implosion at
        // the spot it stood, no attacker involved.
        actor?.die();
        actor?.sparkFlash();
        if (actor !== undefined) this.effects.implosion(this.startPointOf(actor, preset));
        this.reviveAfter(e.objectId, duration);
        break;
      }
      case 'counter': {
        // The stack card shatters instead of resolving (§9): the face hides, its
        // shards burst where it sat, and the card reappears only as the pile top.
        if (actor !== undefined) {
          this.effects.shatter(actor.faceTexture, this.startPointOf(actor, preset), actor.scaleNow);
          actor.vanish();
          this.after(duration + 60, () => this.actorByObject(e.objectId)?.unvanish());
        }
        break;
      }
      default:
        break;
    }
    // Exile is a destination read, not a verb read: the bridge only says `exile`
    // for battlefield→exile — an exiled hand/graveyard/library card arrives as
    // `put` — but the §8/§9 cold rise-and-fade belongs to every flight off-table.
    if (e.to === 'exile') actor?.chill(duration + 300);
  }

  /** End a death read once the fall has landed and settled (§9) — without this,
   *  the pile's top card sits permanently grey and tipped. */
  private reviveAfter(objectId: Id, duration: number): void {
    this.after(duration + 650, () => this.actorByObject(objectId)?.revive());
  }

  /** Where an actor's current move *starts*, in world coordinates — its live
   *  (pre-tween) position, unprojected if the actor still sits in screen space. */
  private startPointOf(actor: CardActor, preset: CameraPreset): Point {
    return actor.space === 'screen' ? screenToWorld(preset, actor.pos) : actor.pos;
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push({ left: ms, fn });
  }

  private advanceTimers(dtMs: number): void {
    if (this.timers.length === 0) return;
    const due: (() => void)[] = [];
    this.timers = this.timers.filter(t => {
      t.left -= dtMs;
      if (t.left <= 0) { due.push(t.fn); return false; }
      return true;
    });
    for (const fn of due) fn();
  }

  /** The live actor carrying object `id` (juice targets objects, not layout keys).
   *  An ability's stack card shares its source permanent's objectId (§3), so a
   *  bare id can be ambiguous: `zone` pins the lookup to the actor actually in
   *  that zone; without one, the non-stack actor (the real card) wins. */
  private actorByObject(id: Id | undefined, zone?: Zone): CardActor | undefined {
    if (id === undefined) return undefined;
    let fallback: CardActor | undefined;
    for (const a of this.actors.values()) {
      if (a.objectId !== id) continue;
      if (zone !== undefined ? a.placement.zone === zone : a.placement.zone !== 'stack') return a;
      fallback ??= a;
    }
    return fallback;
  }

  /** An object's world anchor (its target placement), or undefined for a hand card
   *  in screen space / an unknown id — juice on those has no felt point. */
  private worldPointOf(id: Id | undefined): Point | undefined {
    const a = this.actorByObject(id);
    if (a === undefined || a.space === 'screen') return undefined;
    return { x: a.placement.x, y: a.placement.y };
  }

  /** A seat's world anchor (its nameplate centre) — the target for life/damage
   *  numbers, mana pips, and combat arrows aimed at a player. */
  private seatPoint(playerId: Id | undefined, state: GameState): Point | undefined {
    if (playerId === undefined) return undefined;
    const seat = seatLayouts(state).find(s => s.player.id === playerId);
    if (seat === undefined) return undefined;
    return { x: seat.nameplate.x + NAMEPLATE.w / 2, y: seat.nameplate.y + NAMEPLATE.h / 2 };
  }

  /** §9 combat damage: everyone punching `targetId` lunges at it — an attacker
   *  hits the defending player's nameplate, or falls just short into the blocker
   *  that stopped it; a blocker punches back at its attacker (the pair clash
   *  head-on when they trade). The lunge is a render-only there-and-back on the
   *  actor. Returns the time until the strike lands, so the caller can put the
   *  flash/number/shake on the hit; 0 ⇒ nobody lunged. */
  private lungeAt(targetId: Id, state: GameState): number {
    const target = this.worldPointOf(targetId) ?? this.seatPoint(targetId, state);
    if (target === undefined) return 0;
    const isPlayer = state.players.some(pl => pl.id === targetId);
    const punchers: Id[] = [];
    for (const g of state.combat ?? []) {
      if (g.defenderId === targetId && !g.blocked) punchers.push(...g.attackerIds);
      else if (g.blockerIds.includes(targetId)) punchers.push(...g.attackerIds);
      else if (g.attackerIds.includes(targetId)) punchers.push(...g.blockerIds);
    }
    // Fall short of a card so the faces meet edge-on; a nameplate is flat, so the
    // punch stops at its rim and reads as rapping the plate itself.
    const stopShort = isPlayer ? NAMEPLATE.h / 2 + 14 : 58;
    let impact = 0;
    for (const id of punchers) {
      const actor = this.actorByObject(id, 'battlefield');
      if (actor === undefined || actor.space === 'screen') continue;
      const from = actor.pos;   // live position — settled in its lane by damage time
      const dx = target.x - from.x;
      const dy = target.y - from.y;
      const len = Math.hypot(dx, dy);
      const reach = len - stopShort;
      if (reach < 8) continue;
      const dur = Math.min(460, 220 + reach * 0.3);
      actor.lunge((dx / len) * reach, (dy / len) * reach, dur);
      impact = Math.max(impact, dur * LUNGE_IMPACT_AT);
    }
    return impact;
  }

  // ── stack tethers (design §9, T4): what's on the stack and where it points ─────

  /** Redraw the top-of-stack item's source + target arrows for the current camera.
   *  Screen-space overlay: the pile end comes from the stack actor's projected
   *  bounds, and each felt end (source permanent, target permanent/player) is
   *  projected here, so the whole arrow keystones with the table every frame.
   *  Only the top item is tethered — it is what was just added and what resolves
   *  next, so "arrows show when it lands / re-show as it resolves" falls out. */
  private drawStackTethers(preset: CameraPreset): void {
    const g = this.stackTethers.clear();
    const state = this.director.presented;
    if (state === undefined || this.topStackKey === undefined) return;
    const stackActor = this.actors.get(this.topStackKey);
    const top = state.stack[state.stack.length - 1];
    if (stackActor === undefined || top === undefined) return;
    const pile = centreOf(stackActor.bounds());

    // Source arrow (triggered/activated abilities): the source permanent → the
    // pile. The stackLink binds the ability's ephemeral id to its source; a spell's
    // link points at the stack actor itself (zone 'stack'), which we skip.
    const srcActor = this.actorByObject(this.stackLinks.get(top.id));
    if (srcActor !== undefined && srcActor.placement.zone !== 'stack') {
      const col = srcActor.card !== undefined ? identityColor(srcActor.card) : TETHER_SOURCE;
      this.tether(g, centreOf(srcActor.bounds()), pile, col, false);   // head at the pile
    }

    // Target arrows: the pile → each chosen target (permanent, player, or — for a
    // counterspell — another stack item), head on the thing being pointed at.
    for (const tid of top.targets ?? []) {
      const to = this.targetAnchor(tid, state, preset);
      if (to !== undefined) this.tether(g, pile, to, TETHER_TARGET, true);
    }
  }

  /** The on-screen point of a stack item's target: a live actor's projected centre
   *  (permanent or another stack card), else a player's projected nameplate. */
  private targetAnchor(id: Id, state: GameState, preset: CameraPreset): Point | undefined {
    const actor = this.actorByObject(id);
    if (actor !== undefined) return centreOf(actor.bounds());
    const seat = this.seatPoint(id, state);
    return seat !== undefined ? worldToScreen(preset, seat) : undefined;
  }

  /** One tether: a gently bowed line with an arrowhead at the pointed-at end. Drawn
   *  in screen space (both endpoints are already projected). */
  private tether(g: Graphics, from: Point, to: Point, color: number, arrowAtTo: boolean): void {
    const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    // bow the curve perpendicular to the run, a fixed fraction of its length
    const bow = Math.min(60, len * 0.16);
    const cx = mx - (dy / len) * bow, cy = my + (dx / len) * bow;
    g.moveTo(from.x, from.y).quadraticCurveTo(cx, cy, to.x, to.y)
      .stroke({ width: 3, color, alpha: 0.9, cap: 'round' });
    // arrowhead: aim along the tangent at the pointed-at end (from the control pt)
    const head = arrowAtTo ? to : from;
    const ctrl = { x: cx, y: cy };
    const ang = Math.atan2(head.y - ctrl.y, head.x - ctrl.x);
    const h = 13;
    for (const d of [2.5, -2.5]) {
      g.moveTo(head.x, head.y)
        .lineTo(head.x + Math.cos(ang + d) * h, head.y + Math.sin(ang + d) * h)
        .stroke({ width: 3, color, alpha: 0.9, cap: 'round' });
    }
    g.circle(arrowAtTo ? from.x : to.x, arrowAtTo ? from.y : to.y, 4).fill({ color, alpha: 0.9 });
  }

  // ── actor helpers ────────────────────────────────────────────────────────────

  private createActor(key: string, p: PlacedActor): CardActor {
    const actor = new CardActor(key, p.objectId, this.textureFor(p));
    actor.card = p.card;
    // Every actor is hit-testable (§10: Pixi owns the table). Clicks route through
    // the pending prompt's affordance; hover previews any face-up card.
    actor.view.eventMode = 'static';
    actor.view.on('pointerdown', () => this.maybeBeginDrag(actor));
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
    for (const a of [...this.actors.values(), ...this.carouselActors.values()]) {
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
      const f = preset.scale * depthScaleAt(preset, w);   // screen px per world unit here
      actor.seedCurrent({ x: w.x, y: w.y, rotation: 0, scale: actor.scaleNow / f });
    } else {
      const s = worldToScreen(preset, p);
      const f = preset.scale * depthScaleAt(preset, p);
      actor.seedCurrent({ x: s.x, y: s.y, rotation: 0, scale: actor.scaleNow * f });
    }
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
    this.syncCarousel();              // §4.4 prompt mode opens/closes with its ask
    this.updateStackSpread();         // un-fan the pile when a prompt targets a stack item
    this.updateBoardSpread();         // un-fold candidate piles during a multi-target ask (#24)
    // Nameplates carry prompt state now (§5.2 candidate ring), so the furniture
    // model re-derives on prompt-store changes too — it is spec-cheap (a few
    // dozen shapes/labels); the projection was per-frame all along.
    if (this.director?.presented !== undefined) this.drawFurniture(this.director.presented);
    // A combat declaration frames the whole table while it is open (#7) — the board
    // has nothing declared yet, so only the ask itself can say combat is happening.
    const pendingAsk = prompt?.pending;
    this.director.setDeclaringCombat(
      pendingAsk?.kind === 'priority' && pendingAsk.combat !== undefined);
    if (changed) {
      if (prompt?.pending !== undefined) this.director.flush();   // §6.4: input never waits on animation
      this.syncCameraFocus(this.director.presented);   // §14: pull back for off-screen refs, restore when clear
    }
    this.lastPromptId = newId;
  }

  /** Paint each actor's affordance ring and set its cursor (§7). Pure over the
   *  stored prompt + the live actors, so it is safe to call on every prompt or
   *  transition change. */
  private refreshAffordances(): void {
    const prompt = this.currentPrompt;
    for (const a of [...this.actors.values(), ...this.carouselActors.values()]) {
      const aff = prompt !== undefined && a.objectId !== undefined
        ? affordanceFor(prompt, a.objectId) : undefined;
      a.setHighlight(highlightForAffordance(aff));
      a.view.cursor = isClickable(aff) ? 'pointer' : 'default';
    }
  }

  private handleActorTap(actor: CardActor): void {
    if (this.dragSwallowsTap) { this.dragSwallowsTap = false; return; }
    if (actor.objectId === undefined) return;
    // A graveyard/exile pile top that no prompt affordance claims opens the §4.4
    // browse fan instead of clicking into the void. Candidate cards in a pile
    // keep their prompt meaning — the affordance wins.
    const zone = actor.placement.zone;
    if (actor.space === 'world' && (zone === 'graveyard' || zone === 'exile')
      && actor.placement.ownerId !== undefined
      && (this.currentPrompt === undefined || affordanceFor(this.currentPrompt, actor.objectId) === undefined)) {
      this.onPileOpen?.(actor.placement.ownerId, zone);
      return;
    }
    // A bare tap on a hand card never casts (Issues.txt #10, amends the T7
    // "click-without-drag keeps working" decision): with auto-mana paying the
    // instant the ask lands, a stray click was a finished cast — no cancel
    // window ever existed. Casting is the deliberate gesture (drag past
    // CAST_THRESHOLD, §9); a tap still answers everything else a hand card can
    // be — a discard pick's target, a payMana source.
    if (zone === 'hand' && actor.space === 'screen' && this.currentPrompt !== undefined
      && affordanceFor(this.currentPrompt, actor.objectId)?.kind === 'action') {
      return;
    }
    this.onObjectClick?.(actor.objectId);
  }

  // ── the carousel browser (prompts-on-the-table §4.4) ─────────────────────────

  /** The clamped §4.4 hand page for the current hand size. */
  private handPageNow(state: GameState | undefined): number {
    const n = state?.me.hand.length ?? 0;
    return Math.min(carouselStore.getState().handPage, handPageCount(n) - 1);
  }

  /** Reconcile the fan with what should be showing: derive the content
   *  (prompt mode wins over browse), lay out the current page, and diff the
   *  carousel actors against it. Safe to call from any trigger — prompt change,
   *  state transition, UI-store change, resize — it is pure over those inputs. */
  private syncCarousel(): void {
    if (this.director === undefined) return;
    // Authoritative, not presented (§6.4): whether a candidate is reachable is
    // a question about the true state — the flush snaps the board to it within
    // its budget, and the DOM bar derives from the same source.
    const state = this.latestState ?? this.director.presented;
    const ui = carouselStore.getState();
    const content = carouselContent(this.currentPrompt, state, ui.browse, ui.filter);
    const entries = content?.entries ?? [];
    const fan = layoutCarouselFan(entries.length, pageFor(content?.key), this.size, this.rightInset);
    this.carouselKey = content?.key;

    const live = new Set<string>();
    for (const [index, placement] of fan.placements) {
      const e = entries[index]!;
      const key = `car:${e.id}`;
      live.add(key);
      let actor = this.carouselActors.get(key);
      if (actor === undefined) {
        actor = this.createCarouselActor(key, e);
        this.carouselActors.set(key, actor);
        this.carouselLayer.addChild(actor.view);
        if (this.reducedMotion) {
          actor.snapTo(placement);
        } else {
          // rise in from just below the bottom edge — open and page turns read
          // as the fan sliding up through the table's edge
          actor.seedCurrent({ x: placement.x, y: this.size.h + 180, rotation: 0, scale: placement.scale });
          actor.animateTo(placement, PAGE_TURN_MS);
        }
      } else {
        actor.animateTo(placement, PAGE_TURN_MS);
      }
      // prompt-mode candidates ring exactly like their board twins (§7)
      const aff = this.currentPrompt !== undefined ? affordanceFor(this.currentPrompt, e.id) : undefined;
      actor.setHighlight(highlightForAffordance(aff));
      actor.view.cursor = isClickable(aff) ? 'pointer' : 'default';
    }
    for (const [key, actor] of this.carouselActors) {
      if (!live.has(key)) { actor.destroy(); this.carouselActors.delete(key); }
    }
  }

  private createCarouselActor(key: string, e: CarouselEntry): CardActor {
    const card = carouselCard(e);
    const actor = new CardActor(key, e.id, this.textures.face(card, 'table', 0));
    actor.card = card;
    actor.space = 'screen';
    // Tap + hover only — no pointerdown, so a carousel card can never arm a
    // drag (it answers by click; §4.2 point drags belong to the felt).
    actor.view.eventMode = 'static';
    actor.view.on('pointertap', () => this.handleActorTap(actor));
    actor.view.on('pointerover', () => this.handleActorOver(actor));
    actor.view.on('pointerout', () => this.handleActorOut(actor));
    return actor;
  }

  /** Wheel over the canvas pages the open carousel (§4.4), or zooms the hover
   *  preview (#13).
   *
   *  Precedence, in order: the pointer sitting *on* the preview always zooms it —
   *  you are pointing at the thing you want bigger. Otherwise an open carousel
   *  keeps the wheel as its pager (hovering its cards pops previews constantly, so
   *  zoom-wins would leave it unpageable). With the carousel closed — the felt —
   *  an open preview zooms. */
  private handleWheel(e: WheelEvent): void {
    const rect = this.getPreviewRect?.();
    const onPreview = rect !== undefined
      && e.clientX >= rect.left && e.clientX <= rect.left + rect.width
      && e.clientY >= rect.top && e.clientY <= rect.top + rect.height;
    if ((onPreview || this.carouselKey === undefined)
      && this.onZoomPreview?.(e.deltaY !== 0 ? e.deltaY : e.deltaX) === true) {
      e.preventDefault();
      return;
    }
    if (this.carouselKey === undefined) return;
    const state = this.latestState ?? this.director?.presented;
    const ui = carouselStore.getState();
    const content = carouselContent(this.currentPrompt, state, ui.browse, ui.filter);
    if (content === undefined) return;
    e.preventDefault();
    const delta = (e.deltaY !== 0 ? e.deltaY : e.deltaX) > 0 ? 1 : -1;
    turnPage(content.key, delta, carouselPageCount(content.entries.length));
  }

  // ── drag-to-cast (prompts-on-the-table §9) ───────────────────────────────────

  /** A press arms a drag when the subject supports one. Arming is not dragging:
   *  the press stays an ordinary click until the pointer travels DRAG_SLOP_PX.
   *
   *  Three subjects, in precedence order:
   *   • a combat candidate (§5.1) — the toggle-in `{object}` sends on the press
   *     itself (the wire is one toggle per round trip); the same hold becomes
   *     the attack/block pointer, and the release records the §4.3 intent for
   *     the follow-up ask. Release-without-drag is just the toggle.
   *   • the asking spell during chooseTargets (§5.2) — the stack-top card is
   *     the press subject; the release lands on a candidate. No press click.
   *   • a castable hand card (§9) — drag-to-cast. manaOnly never lifts (§7 —
   *     never a click target either), and target/source affordances on hand
   *     cards keep their click-select meaning. */
  private maybeBeginDrag(actor: CardActor): void {
    this.dragSwallowsTap = false;   // a fresh press always clears a stale swallow
    const prompt = this.currentPrompt;
    if (this.pointer === undefined || prompt === undefined || prompt.inflight) return;
    if (actor.objectId === undefined) return;
    const aff = affordanceFor(prompt, actor.objectId);
    if (aff?.kind === 'combatCandidate') {
      this.dragSwallowsTap = true;   // the press already acted — the release tap must not re-toggle
      this.onObjectClick?.(actor.objectId);
      this.armDrag('point', HL_COMBAT, actor);
      return;
    }
    // `aff === undefined` matters: when the ask targets stack items (a
    // counterspell pick), the top card is a *candidate* and the press must stay
    // the plain candidate click, not become a source drag. Any non-candidate
    // world actor can be the source — the asking spell on the stack top (§5.2),
    // or a declared attacker whose "Select defender" follow-up arrived with no
    // drag in flight (the All Attack path, §5.1). Legality stays with
    // pointTarget: an off-candidate release records an intent that expires.
    if (prompt.pending?.kind === 'chooseTargets' && actor.space === 'world' && aff === undefined) {
      this.armDrag('point', HL_TARGET, actor);
      return;
    }
    if (actor.space !== 'screen' || actor.placement.zone !== 'hand') return;
    if (aff?.kind !== 'action') return;
    this.armDrag('cast', 0, actor);   // cast mode draws no line — color unused
  }

  private armDrag(mode: 'cast' | 'point', color: number, actor: CardActor): void {
    this.drag = {
      mode, color, key: actor.key, objectId: actor.objectId!,
      startX: this.pointer!.x, startY: this.pointer!.y, moved: false,
    };
  }

  /** Per-frame drag pin, after the tweens and before paint: the dragged card
   *  sits under the pointer whatever the layout is doing. A mid-drag transition
   *  can retarget the actor's tween freely — the pin wins each frame, and the
   *  release hands a clean current-position back to the tween system. */
  private updateDrag(): void {
    const d = this.drag;
    if (d === undefined) return;
    const actor = this.actors.get(d.key);
    if (actor === undefined) { this.drag = undefined; this.dragLine.clear(); return; }   // re-keyed away mid-drag
    const p = this.pointer;
    if (p === undefined) return;                                  // off-canvas: hold the last pin
    if (!d.moved) {
      if (Math.hypot(p.x - d.startX, p.y - d.startY) < DRAG_SLOP_PX) return;
      d.moved = true;
      this.hidePreview();
      if (d.mode === 'cast') {
        this.lowerHand();
        this.screenActors.addChild(actor.view);   // reads above the fan while dragged
      }
    }
    // Only the cast lift pins the card to the pointer; a point drag leaves the
    // subject where it stands and speaks through the chalk line (§4.2).
    if (d.mode === 'cast') actor.seedCurrent({ x: p.x, y: p.y, rotation: 0, scale: actor.placement.scale });
  }

  /** The §4.2 chalk line, redrawn each frame of a moved point drag: subject's
   *  projected centre → pointer, arrowhead at the pointer. Cleared otherwise. */
  private drawDragLine(): void {
    const g = this.dragLine.clear();
    const d = this.drag;
    if (d === undefined || !d.moved || d.mode !== 'point' || this.pointer === undefined) return;
    const actor = this.actors.get(d.key);
    if (actor === undefined) return;
    this.tether(g, centreOf(actor.bounds()), this.pointer, d.color, true);
  }

  /** Release. Cast mode: above the cast line → the same {object} answer a click
   *  sends; at or below it → nothing. Either way the card slides home: on a
   *  successful cast the next transition retargets the tween mid-flight from
   *  wherever the card is (§6.3), so the slide never fights the fly-to-stack,
   *  and on a rejected answer the card is simply back in the fan.
   *  Point mode: resolve what the release landed on and hand it to
   *  onPointTarget; landing on nothing means the line just evaporates (§4.2).
   *  The felt never sees this release (the press began on a card, so no felt
   *  tap can fire). */
  private endDrag(e: PointerEvent): void {
    const d = this.drag;
    if (d === undefined) return;
    this.drag = undefined;
    this.dragLine.clear();
    if (!d.moved) return;                        // plain click — pointertap handles it
    this.dragSwallowsTap = true;
    const r = this.app.canvas.getBoundingClientRect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (d.mode === 'point') {
      const target = this.dropTargetAt(p, d.objectId);
      if (target !== undefined) this.onPointTarget?.(target);
      return;
    }
    const actor = this.actors.get(d.key);
    if (actor === undefined) return;
    if (p.y < this.size.h * (1 - CAST_THRESHOLD)) this.onObjectClick?.(d.objectId);
    actor.animateTo(actor.placement, DRAG_HOME_MS);
  }

  /** pointercancel (tab switch, pen lift-off): never cast, never target — the
   *  card just comes home / the line evaporates. */
  private cancelDrag(): void {
    const d = this.drag;
    if (d === undefined) return;
    this.drag = undefined;
    this.dragLine.clear();
    if (!d.moved) return;
    this.dragSwallowsTap = true;
    if (d.mode === 'cast') {
      this.actors.get(d.key)?.animateTo(this.actors.get(d.key)!.placement, DRAG_HOME_MS);
    }
  }

  /** What a point-drag release landed on, as an id the shared affordance/intent
   *  layer can judge (§5.1: "a nameplate, quadrant, or planeswalker/battle" —
   *  §5.3 blockers: the attacking creature). Precedence: an actor that is a
   *  live candidate of the pending chooseTargets → a nameplate's player → any
   *  other actor hit → the quadrant's seat. The legality check stays with
   *  pointTarget/the intent buffer — an off-target drop records an intent that
   *  expires harmlessly. */
  private dropTargetAt(p: Point, sourceId: Id): Id | undefined {
    const pending = this.currentPrompt?.pending;
    const candidates = pending?.kind === 'chooseTargets' ? new Set(pending.candidates) : undefined;
    let anyHit: Id | undefined;
    for (const a of this.actors.values()) {
      if (a.objectId === undefined || a.objectId === sourceId) continue;
      if (!anchorContains(a.bounds(), p)) continue;
      if (candidates?.has(a.objectId) === true) return a.objectId;
      anyHit ??= a.objectId;
    }
    const state = this.director.presented;
    if (state !== undefined) {
      const w = screenToWorld(this.director.cameraPreset(), p);
      const seats = seatLayouts(state);
      for (const seat of seats) {
        const plate: Rect = { x: seat.nameplate.x, y: seat.nameplate.y, w: NAMEPLATE.w, h: NAMEPLATE.h };
        if (rectContains(plate, w)) return seat.player.id;
      }
      if (anyHit !== undefined) return anyHit;
      const seat = seats.find(s => rectContains(s.quadrant, w));
      if (seat !== undefined) return seat.player.id;
    }
    return anyHit;
  }

  private handleActorOver(actor: CardActor): void {
    if (this.drag?.moved === true) return;   // a dragged card crossing others pops nothing
    if (actor.objectId === undefined || !actor.placement.faceUp) return;
    // Hand cards read via the in-place raise (§9) — no corner preview. Every other
    // face-up card gets the preview panel instead.
    if (actor.space === 'screen' && actor.placement.zone === 'hand') this.raiseHand(actor);
    else this.showPreview(actor);
  }

  private handleActorOut(actor: CardActor): void {
    // Only the lift reacts to a raw pointerout; the preview is dismissed by the
    // frame-loop authority (verifyHover), so crossing onto the panel keeps it open.
    if (this.hoveredKey === actor.key) this.lowerHand();
  }

  /** Raise a hand card to the front and enlarge it in place (§9). Lowers any
   *  previously-raised card and dismisses any board preview, so only one thing is
   *  ever emphasised. */
  private raiseHand(actor: CardActor): void {
    if (this.hoveredKey === actor.key) return;
    this.hidePreview();
    if (this.hoveredKey !== undefined) this.actors.get(this.hoveredKey)?.setHover(false);
    this.hoveredKey = actor.key;
    actor.setHover(true);
    this.screenActors.addChild(actor.view);   // reads above the rest of the fan
  }

  /** Lower the raised hand card and restore the fan's natural z-order. */
  private lowerHand(): void {
    if (this.hoveredKey === undefined) return;
    this.actors.get(this.hoveredKey)?.setHover(false);
    this.hoveredKey = undefined;
    this.restackScreen();
  }

  /** Show the corner preview for a non-hand card and (re)arm its dismissal grace. */
  private showPreview(actor: CardActor): void {
    this.previewActorKey = actor.key;
    this.previewGrace = HOVER_GRACE_MS;
    this.onObjectHover?.(actor.objectId, this.actorAnchor(actor));
  }

  /** Hide the corner preview outright. */
  private hidePreview(): void {
    if (this.previewActorKey === undefined) return;
    this.previewActorKey = undefined;
    this.onObjectHover?.(undefined);
  }

  /** Re-append the screen-space actors (hand + stack) in layout order, restoring the
   *  natural fan z-order after a hover raised one card to the front. Cheap — same
   *  keys, no create/destroy, no tween. */
  private restackScreen(): void {
    const state = this.director.presented;
    if (state === undefined) return;
    const placed = layoutKeyed(state, this.size, this.stackLinks, this.rightInset, this.spreadStack,
      this.handPageNow(state), this.spreadBoard);
    for (const [key, p] of placed) {
      if (p.space !== 'screen') continue;
      const actor = this.actors.get(key);
      if (actor !== undefined) this.screenActors.addChild(actor.view);
    }
  }

  /** The scene's per-frame hover authority — the fix for the sticking preview.
   *  Pixi only fires `pointerout` on pointer *movement*, so a card that animates
   *  away or a camera pan (or the pointer resting on the click-through preview) would
   *  strand the hover. Instead we re-decide from the live pointer every frame:
   *   • lift — held only while the pointer is over the raised hand card's *resting*
   *     footprint (never the enlarged visual, or it would swallow its neighbours);
   *   • preview — held only while the pointer is over its card or over the preview
   *     panel's own rect, with a grace to bridge the gap; otherwise it hides. */
  private verifyHover(dtMs: number): void {
    if (this.hoveredKey !== undefined) {
      const actor = this.actors.get(this.hoveredKey);
      if (actor === undefined || this.pointer === undefined || !anchorContains(actor.hitBounds(), this.pointer)) {
        this.lowerHand();
      }
    }
    if (this.previewActorKey !== undefined) {
      const actor = this.actors.get(this.previewActorKey) ?? this.carouselActors.get(this.previewActorKey);
      const p = this.pointer;
      const onCard = actor !== undefined && p !== undefined && anchorContains(actor.bounds(), p);
      const rect = this.getPreviewRect?.();
      const onPanel = rect !== undefined && p !== undefined && anchorContains(rect, p);
      if (actor === undefined) this.hidePreview();                 // card gone → drop now
      else if (onCard || onPanel) this.previewGrace = HOVER_GRACE_MS;
      else if ((this.previewGrace -= dtMs) <= 0) this.hidePreview();
    }
  }

  /** The on-screen rect of an actor's card face, for anchoring a DOM hover
   *  preview (§10 sceneToScreen). Composes layout with the live camera preset;
   *  world actors project through it, the screen-space hand does not. */
  private actorAnchor(actor: CardActor): ScreenAnchor {
    return actor.bounds();   // the projected face's on-screen bbox from the last frame
  }

  private handleFeltTap(e: FederatedPointerEvent): void {
    const state = this.director.presented;
    if (state === undefined) return;
    // worldLayer is identity now — the tap arrives in screen space; unproject it
    // through the live camera (perspective included) to hit-test the quadrants.
    const local = screenToWorld(this.director.cameraPreset(), { x: e.global.x, y: e.global.y });
    // §5.2: a nameplate is a click target while its player is a chooseTargets
    // candidate ("Select defender", targeted removal at a player). Plates are
    // furniture (eventMode none), so the tap falls through to the felt — catch
    // it here before the camera-focus read. Precise on purpose: only the plate
    // answers on a plain tap; the forgiving whole-quadrant drop belongs to the
    // drag release (dropTargetAt).
    const pending = this.currentPrompt?.pending;
    if (pending?.kind === 'chooseTargets' && this.currentPrompt?.inflight !== true) {
      for (const seat of seatLayouts(state)) {
        const plate: Rect = { x: seat.nameplate.x, y: seat.nameplate.y, w: NAMEPLATE.w, h: NAMEPLATE.h };
        if (rectContains(plate, local) && pending.candidates.includes(seat.player.id)) {
          this.onObjectClick?.(seat.player.id);
          return;
        }
      }
    }
    // A graveyard/exile footprint click opens the §4.4 browse fan — checked
    // before the quadrant focus, or an *empty* pile (no top-card actor to tap)
    // could never be browsed.
    for (const seat of seatLayouts(state)) {
      for (const zone of ['graveyard', 'exile'] as const) {
        const a = seat.piles[zone];
        const rect: Rect = {
          x: a.x - PILE_FOOTPRINT.w / 2, y: a.y - PILE_FOOTPRINT.h / 2,
          w: PILE_FOOTPRINT.w, h: PILE_FOOTPRINT.h,
        };
        if (rectContains(rect, local)) { this.onPileOpen?.(seat.player.id, zone); return; }
      }
    }
    const seat = seatLayouts(state).findIndex(s => rectContains(s.quadrant, local));
    if (seat >= 0) (this.onFocusSeat ?? ((d: number) => this.director.focusSeat(d)))(seat);
  }

  /** The on-screen rect of the actor rendering `objectId`, if any — the anchor
   *  for a DOM prompt surface pinned to its subject (§5.4 chooseAbility). */
  anchorFor(objectId: Id): ScreenAnchor | undefined {
    return this.actorByObject(objectId)?.bounds();
  }

  /** §14: keep everything that must be seen in shot — pull back to the whole table
   *  while any of it sits off-screen under the pinned/followed view, and ease back
   *  once it's all visible again. Two orthogonal sources of "must be seen":
   *   • the current prompt's named objects (forced choices / combat declaration) —
   *     what *you* must see to act; and
   *   • every target of anything on the stack — a cross-battlefield effect (the
   *     active player casting removal at another seat's creature while you follow the
   *     caster) that would otherwise resolve off-screen. A target on the framed
   *     board is already in shot, so a same-seat effect never widens the lens.
   *  Recomputed on every prompt change *and* every state transition, so the pull-back
   *  tracks the live stack and never outlives its reason (the spell resolves off the
   *  stack → its target drops out → the lens returns to the pin/follow). Screen-space
   *  objects (your hand) are always visible; only felt anchors — a permanent's
   *  placement or a targeted player's nameplate — contribute points. */
  private syncCameraFocus(state: GameState | undefined): void {
    const pts: Point[] = [];
    const prompt = this.currentPrompt;
    if (prompt?.pending !== undefined) {
      const ids = new Set(promptObjectIds(prompt));
      for (const a of this.actors.values()) {
        if (a.objectId !== undefined && a.space === 'world' && ids.has(a.objectId)) {
          pts.push({ x: a.placement.x, y: a.placement.y });
        }
      }
    }
    if (state !== undefined) {
      for (const tid of stackTargetIds(state.stack)) {
        const p = this.worldPointOf(tid) ?? this.seatPoint(tid, state);
        if (p !== undefined) pts.push(p);
      }
    }
    this.director.keepVisible(pts);
  }

  // ── camera controls (design §7.3), delegated to the director ──────────────────

  focusSeat(display: number): void { this.director.focusSeat(display); }
  showTable(): void { this.director.showTable(); }
  releaseCamera(): void { this.director.releaseCamera(); }

  /** The log panel's current intrusion from the right edge (0 when collapsed): the
   *  camera frames the felt clear of it *and* the hand fan re-centres in what's
   *  left (§8), so neither the board nor the hand tucks under the panel. Called by
   *  the chrome whenever the sidebar opens, collapses, or is resized. */
  setLogInset(px: number): void {
    this.director?.setRightInset(px);
    const inset = Math.max(0, Math.round(px));
    if (inset === this.rightInset) return;
    this.rightInset = inset;
    this.recentreHand();
  }

  /** Slide the hand to stay centred in the felt left of the log gutter (§8). The
   *  world layout is inset-free (the camera handles it), so this re-runs only the
   *  screen layer and eases the existing fan actors — no create/destroy. */
  private recentreHand(): void {
    this.relayScreen(HAND_RECENTRE_MS);
  }

  /** Ease the screen-space actors (hand + stack) to a freshly-computed layout at
   *  the current inset + spread state — no create/destroy, same keys. Runs on a log
   *  toggle (the fan re-centres, the pile re-pins) and on a stack spread/collapse.
   *  Goes through `layoutKeyed` so an adopted stack actor is found by its real key. */
  private relayScreen(durationMs: number): void {
    const state = this.director?.presented;
    if (state === undefined) return;
    const placed = layoutKeyed(state, this.size, this.stackLinks, this.rightInset, this.spreadStack,
      this.handPageNow(state), this.spreadBoard);
    for (const [key, p] of placed) {
      if (p.space !== 'screen') continue;
      const actor = this.actors.get(key);
      if (actor?.space === 'screen') actor.animateTo(p.placement, durationMs);
    }
  }

  /** Recompute whether the pending prompt targets a stack item; on a change, un-fan
   *  (or re-collapse) the pile so buried candidates become clickable (§7 T4). */
  private updateStackSpread(): void {
    const want = this.promptTargetsStackItem();
    if (want === this.spreadStack) return;
    this.spreadStack = want;
    this.relayScreen(HAND_RECENTRE_MS);
  }

  private promptTargetsStackItem(): boolean {
    const prompt = this.currentPrompt;
    if (prompt?.pending === undefined) return false;
    for (const a of this.actors.values()) {
      if (a.placement.zone === 'stack' && a.objectId !== undefined && isClickable(affordanceFor(prompt, a.objectId))) {
        return true;
      }
    }
    return false;
  }

  /** During a multi-target ask, candidate ids refuse to fold into board piles —
   *  folded, only the top of a treasure stack could ever be picked (#24). The
   *  members tween apart into their own grid cells and fold back when the ask
   *  clears; a single-target pick keeps its piles (fold members are fungible by
   *  construction — `stackKey` only merges identical state). */
  private updateBoardSpread(): void {
    const p = this.currentPrompt?.pending;
    const want: ReadonlySet<Id> = p?.kind === 'chooseTargets' && p.max > 1
      ? new Set(p.candidates) : new Set<Id>();
    if (want.size === this.spreadBoard.size && [...want].every(id => this.spreadBoard.has(id))) return;
    this.spreadBoard = want;
    const presented = this.director?.presented;
    if (presented !== undefined) {
      this.applyTransition(presented, presented, [], HAND_RECENTRE_MS, this.stackLinks);
    }
  }

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

  /** Bake the static felt surface (rail-inset cloth, edge, quarter folds, and each
   *  seat's pool of lamplight) into a world-sized texture, then hand it to the felt
   *  mesh. The lamplight rides the felt so it keystones with the surface for free.
   *  Rebuilt only when the seat layout moves (guarded by a signature) — the mesh's
   *  four corners are re-projected every frame regardless. */
  private rebuildFelt(state: GameState): void {
    const seats = seatLayouts(state);
    const sig = seats.map(s => `${Math.round(s.lamplight.x)},${Math.round(s.lamplight.y)},${Math.round(s.lamplight.r)}`).join('|');
    if (sig === this.feltSig && this.feltTex !== undefined) return;
    this.feltSig = sig;
    const g = new Graphics();
    g.roundRect(0, 0, WORLD.w, WORLD.h, 36).fill(FELT);
    g.roundRect(6, 6, WORLD.w - 12, WORLD.h - 12, 30).stroke({ width: 10, color: FELT_EDGE, alpha: 0.9 });
    // quarter folds, stopping short of the edges (§7.2)
    g.moveTo(WORLD.w / 2, WORLD.h * 0.06).lineTo(WORLD.w / 2, WORLD.h * 0.94)
      .moveTo(WORLD.w * 0.06, WORLD.h / 2).lineTo(WORLD.w * 0.94, WORLD.h / 2)
      .stroke({ width: 2, color: 0x000000, alpha: 0.16 });
    for (const seat of seats) {
      const { x, y, r } = seat.lamplight;
      g.circle(x, y, r).fill({ color: 0xffe6ad, alpha: 0.05 });
    }
    const tex = this.app.renderer.generateTexture({ target: g, frame: new Rectangle(0, 0, WORLD.w, WORLD.h), resolution: 1 });
    this.feltMesh.texture = tex;
    this.feltTex?.destroy(true);
    this.feltTex = tex;
    g.destroy();
  }

  /** Rebuild the furniture model for a new state: shape specs (drawn as projected
   *  quads each frame, so they keystone) plus text labels (billboarded upright).
   *  Cheap — no render textures. */
  private drawFurniture(state: GameState): void {
    for (const c of this.furnitureText.removeChildren()) c.destroy();
    this.shapeSpecs = [];
    this.textItems = [];
    for (const seat of seatLayouts(state)) {
      this.drawPiles(seat);
      this.drawNameplate(seat, state);
      this.drawHandCount(seat, state.me.playerId);
    }
  }

  /** A billboarded furniture label: created here, then positioned + depth-scaled at
   *  its world `anchor` every frame by `projectFurniture`. Returned for measurement. */
  private addFurnitureText(content: string, style: TextStyle, ax: number, ay: number, anchor: Point): Text {
    const node = new Text({ text: content, style });
    node.anchor.set(ax, ay);
    this.furnitureText.addChild(node);
    this.textItems.push({ node, anchor });
    return node;
  }

  /** Each seat's pile column (§7.2 ".zones"): a footprint quad (keystoned) under the
   *  real card stack plus a count label, so a 1-card graveyard reads apart from an
   *   18-card one. Empty zones are a faint outline (not a solid block that mimics a
   *  card); exile stays cold so "gone" never reads as "dead" (§8). */
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
      const rect: Rect = { x: a.x - w / 2, y: a.y - h / 2, w, h };
      if (count === 0) this.shapeSpecs.push({ rect, stroke: { width: 1.5, color: cold ? 0x486070 : 0x000000, alpha: 0.3 } });
      else this.shapeSpecs.push({ rect, fill: { color: cold ? 0x121d24 : 0x000000, alpha: cold ? 0.42 : 0.3 } });

      // The command zone is always 1–2 (the commander), so a count there is noise —
      // the zone tag alone. Every other pile carries its size.
      this.addFurnitureText(
        zone === 'command' ? PILE_LABEL[zone] : `${PILE_LABEL[zone]} ${count}`,
        new TextStyle({
          fontFamily: 'ui-monospace, monospace', fontSize: 15, letterSpacing: 1,
          fill: count === 0 ? 0x6c7871 : 0xa6b0a9, fontWeight: '600',
        }),
        0.5, 0, { x: a.x, y: a.y + h / 2 + 6 },
      );
    }
  }

  /** The public count of an opponent's held hand, beside their back-fan (§7.2
   *  ".held-n"). My own hand is the screen-space fan, so it carries no count here. */
  private drawHandCount(seat: SeatLayout, meId: Id): void {
    const p = seat.player;
    if (p.id === meId || p.handSize === 0) return;
    const side = seat.corner.left ? 1 : -1;   // the glyph sits inboard of the fan
    this.addFurnitureText(
      `${p.handSize}`,
      new TextStyle({ fontFamily: 'ui-monospace, monospace', fontSize: 16, fill: 0x8b95a0, fontWeight: '700' }),
      side === 1 ? 0 : 1, 0.5,
      { x: seat.handFan.x + side * (opponentHandHalfWidth(p.handSize) + 10), y: seat.handFan.y },
    );
  }

  private drawNameplate(seat: SeatLayout, state: GameState): void {
    const n = NAMEPLATE;
    const p = seat.player;
    const box = seat.nameplate;
    // §9 attack: the defending player carries the state directly — the plate turns
    // to danger with the incoming unblocked damage on it (the chalk arrow on the
    // felt can be occluded by cards).
    const incoming = incomingUnblockedDamage(state, p.id);
    // §5.2 T8: while this player is a chooseTargets candidate the plate rings
    // like any candidate card (selected = in the multi-pick scratch) — it is
    // clickable (felt tap) and a drag-release target, so it must look like one.
    const target = this.plateTarget(p.id);
    this.shapeSpecs.push({
      rect: { x: box.x, y: box.y, w: n.w, h: n.h },
      fill: { color: incoming > 0 ? DMG_FILL : BRASS_FILL, alpha: 1 },
      stroke: target !== undefined
        ? { width: target.selected ? 4 : 2.5, color: HL_TARGET, alpha: 1 }
        : incoming > 0
          ? { width: 2, color: 0xc0392b, alpha: 1 }
          : { width: 1.5, color: BRASS, alpha: 1 },
    });
    const dead = p.flags?.dead === true || p.flags?.left === true;
    this.addFurnitureText(
      `${p.name}`,
      new TextStyle({ fontFamily: 'Georgia, serif', fontSize: 22, fill: dead ? 0x8a8375 : INK, fontWeight: '600' }),
      0, 0.5, { x: box.x + 12, y: box.y + n.h / 2 },     // left-pinned, vertically centred
    );
    this.addFurnitureText(
      `${p.life}`,
      new TextStyle({ fontFamily: 'Georgia, serif', fontSize: 22, fill: incoming > 0 ? DMG_INK : INK, fontWeight: '700' }),
      1, 0.5, { x: box.x + n.w - 12, y: box.y + n.h / 2 },
    );
    const chips: SeatChip[] = commanderDamageRows(state, p).map(row => {
      const short = (row.commander.split(/[ ,]/)[0] ?? row.commander).slice(0, 6);
      return { label: `⚔ ${short} ${row.amount}`, tone: 'danger' as const };
    });
    if (incoming > 0) chips.unshift({ label: `⚔ ${incoming} incoming`, tone: 'danger' });
    // Player counters (§6: poison, energy, experience, …) — visible where the
    // player is, not buried in a panel (#26). Poison kills, so it reads as danger.
    for (const c of p.counters ?? []) {
      const icon = COUNTER_ICON[c.name.toLowerCase()] ?? c.name;
      chips.push({ label: `${icon} ${c.count}`, tone: c.name.toLowerCase() === 'poison' ? 'danger' : 'note' });
    }
    this.drawSeatChips(seat, chips);
  }

  /** Seat chips — commander damage per attacking commander (§6), the
   *  incoming-unblocked-damage danger chip during combat (§9), and player
   *  counters (#26) — so lethal (and energy) creeps up where the victim reads
   *  it, without tracing a combat arrow. Laid in a strip on the *rail side* of
   *  the plate (below a near seat, above a far seat), centred under it: the old
   *  strip ran off the right of the plate, straight under an opponent's inboard
   *  hand fan, which hid it (reviewed 2026-07-23). Chip boxes keystone; their
   *  text billboards. Danger chips are the cold red pills; note chips read in
   *  the plate's own brass so they never cry wolf. */
  private drawSeatChips(seat: SeatLayout, chips_: SeatChip[]): void {
    if (chips_.length === 0) return;
    const h = 18;
    const gap = 5;
    const centerX = seat.nameplate.x + NAMEPLATE.w / 2;
    const chips = chips_.map(({ label, tone }) => {
      const style = new TextStyle({
        fontFamily: 'ui-monospace, monospace', fontSize: 13,
        fill: tone === 'danger' ? DMG_INK : INK, fontWeight: '700',
      });
      const node = new Text({ text: label, style });
      return { node, tone, w: Math.round(node.width) + 12 };
    });
    const totalW = chips.reduce((s, c) => s + c.w, 0) + gap * (chips.length - 1);
    const cy = seat.bandY + seat.out * (NAMEPLATE.h / 2 + h / 2 + 2);
    let x = centerX - totalW / 2;
    for (const chip of chips) {
      this.shapeSpecs.push({
        rect: { x, y: cy - h / 2, w: chip.w, h },
        fill: { color: chip.tone === 'danger' ? DMG_FILL : BRASS_FILL, alpha: 1 },
        stroke: { width: 1, color: chip.tone === 'danger' ? DMG_EDGE : BRASS, alpha: 1 },
      });
      chip.node.anchor.set(0, 0.5);
      this.furnitureText.addChild(chip.node);
      this.textItems.push({ node: chip.node, anchor: { x: x + 6, y: cy } });
      x += chip.w + gap;
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

  /** Whether a player's nameplate rings as a chooseTargets candidate (§5.2),
   *  and whether the multi-pick scratch already holds them. */
  private plateTarget(playerId: Id): { selected: boolean } | undefined {
    const prompt = this.currentPrompt;
    if (prompt?.pending?.kind !== 'chooseTargets') return undefined;
    if (!prompt.pending.candidates.includes(playerId)) return undefined;
    return { selected: prompt.selected.includes(playerId) };
  }

  /** §12/§13 highlights accessor — the object ids the felt is currently ringing
   *  as clickable. The classic client proves its no-dead-end invariant with a
   *  `.hl-*` DOM count; on the canvas the ring is a Pixi graphic, so the harness
   *  reports it from the same affordance the ring was painted from. Dock and modal
   *  buttons are DOM in both clients and counted by the driver separately. */
  highlights(): Id[] {
    const prompt = this.currentPrompt;
    if (prompt === undefined) return [];
    const ids: Id[] = [];
    for (const a of [...this.actors.values(), ...this.carouselActors.values()]) {
      if (a.objectId === undefined || ids.includes(a.objectId)) continue;
      if (isClickable(affordanceFor(prompt, a.objectId))) ids.push(a.objectId);
    }
    // Player candidates ring on their nameplates (§5.2), which are furniture,
    // not actors — report them too or the no-dead-end poll reads a "Select
    // defender" ask as offering nothing.
    const pending = prompt.pending;
    if (pending?.kind === 'chooseTargets') {
      const state = this.director?.presented;
      for (const id of pending.candidates) {
        if (state?.players.some(pl => pl.id === id) === true && !ids.includes(id)) ids.push(id);
      }
    }
    return ids;
  }

  destroy(): void {
    if (getActiveScene() === this) setActiveScene(null);
    this.detachPointer?.();
    this.unsubResolver?.();
    this.unsubCarousel?.();
    this.effects.clear();
    this.timers = [];
    for (const a of this.actors.values()) a.destroy();
    this.actors.clear();
    for (const a of this.carouselActors.values()) a.destroy();
    this.carouselActors.clear();
    this.feltTex?.destroy(true);
    this.textures?.destroy();
    this.app?.destroy(true, { children: true });
  }
}

/** The centre of an on-screen bounding box (a projected actor face). */
function centreOf(b: ScreenAnchor): Point {
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}

/** The card a carousel entry renders: the real card when the state resolves
 *  one, else a minimal text-frame stand-in carrying the candidate's label —
 *  the click answers by id either way (§4.4). */
function carouselCard(e: CarouselEntry): Card {
  return e.card ?? {
    id: e.id, name: e.label, set: '', number: '', manaValue: 0,
    types: [], subtypes: [], supertypes: [], colors: [], text: [],
  };
}

/** Whether a screen-space point falls inside a projected actor's bounding box. */
function anchorContains(b: ScreenAnchor, p: Point): boolean {
  return p.x >= b.left && p.x <= b.left + b.width && p.y >= b.top && p.y <= b.top + b.height;
}

/** The upward bow of a move's path (design §9), in the actor's own-space units
 *  (screen px for the hand, world px on the felt). A cast lifts high, a draw and a
 *  bounce arc, a resolve/land drops nearly straight — and anything bound for exile
 *  rises off the table (§9) whatever its verb (`put` covers non-battlefield exiles). */
function arcForMove(verb: Verb | undefined, space: ActorSpace, to: Zone | undefined): number {
  const base = space === 'screen' ? 120 : 90;
  if (to === 'exile') return 110;
  switch (verb) {
    case 'cast': return base;
    case 'draw': return base * 0.7;
    case 'bounce': case 'tutor': return base * 0.8;
    case 'resolve': return space === 'screen' ? 0 : 40;
    case 'play': return 30;
    default: return 0;
  }
}

/** Total power of the unblocked attackers currently aimed at `playerId` (§9
 *  attack: the defender's plate carries the threat directly). Non-numeric power
 *  ("*") counts as 0 — an understatement beats a NaN. */
function incomingUnblockedDamage(state: GameState, playerId: Id): number {
  let total = 0;
  for (const g of state.combat ?? []) {
    if (g.defenderId !== playerId || g.blocked) continue;
    for (const aid of g.attackerIds) {
      for (const pl of state.players) {
        const perm = pl.battlefield.find(b => b.id === aid);
        if (perm !== undefined) { total += Number(perm.power) || 0; break; }
      }
    }
  }
  return total;
}

const PHASE_LABEL: Record<Phase, string> = {
  BEGINNING: 'Beginning', PRECOMBAT_MAIN: 'Main Phase', COMBAT: 'Combat',
  POSTCOMBAT_MAIN: 'Second Main', END: 'End Step',
};

/** The banner text for a phase ribbon (design §9 `step`). */
function phaseLabel(phase: Phase, _step: Step | undefined): string {
  return PHASE_LABEL[phase] ?? String(phase);
}

// Module-level handle so the composition root's harness scene() can read the
// live table without threading the instance through React.
let activeScene: TableScene | null = null;
export function setActiveScene(s: TableScene | null): void { activeScene = s; }
export function getActiveScene(): TableScene | null { return activeScene; }
