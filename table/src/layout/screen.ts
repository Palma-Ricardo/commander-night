// layoutScreen — the screen-space layer (design §7.1): the zones pinned to the
// viewport, visible no matter where the camera points. Two live here now: your
// hand, fanned along the bottom edge, and the **stack**, a right-edge pile (T4).
// Everything else is on the felt (`layoutWorld`, camera-transformed); this is the
// one function that sees the viewport. Screen actors are still Pixi actors (§10),
// so a cast lifts a card out of the hand fan and flies it straight onto the stack
// as one continuous actor — both endpoints now share this layer, so the hand→stack
// motion no longer crosses the world↔screen seam (T4 cast animation). Pure and
// headless — no renderer, no camera, no time.

import type { GameState, StackItem } from '@night/core';
import { chosenX, substituteX } from '../text';
import type { ActorPlacement, PlacedActor, Point, Size } from './types';

const CARD_TEX = { w: 200, h: 280 } as const;

// The hand fan's feel. Cards overlap so a crowded hand still reads (the left
// ~62% of each shows — the name, the cost, most of the art), the same reading the
// carousel strip relies on. Past what fits, the fan *scrolls* rather than
// cramming or paging (modelled on the carousel, Issues.txt #8).
const HAND_STEP_RATIO = 0.62;   // centre-to-centre spacing, as a fraction of a card
const HAND_MARGIN = 48;         // clear space kept at both ends of the run
// The reading window, in cards. The fan scrolls once it outgrows this many even
// when the felt could hold more — a fan wider than this stops being a hand you can
// take in at a glance, and a wide display would otherwise never scroll at all. The
// carousel strip caps itself the same way (STRIP_VISIBLE); a hand can hold a few
// more before it reads as a wall.
const HAND_VISIBLE = 12;
const HAND_MAX_ROT = 0.1;       // per-card fan rotation at the run's edge (radians)
const HAND_ARC = 0.10;          // downward arc at the run's edge, as a fraction of the band
// Width of the dissolve at each end of the run, in cards: the fan thins into the
// felt rather than stopping at a hard edge, so it reads as a longer hand passing
// through a window and the fade itself says "there is more this way" — exactly the
// carousel strip's ends (stripAlphaAt), kept in step deliberately.
const HAND_FADE_CARDS = 0.7;

/** A phone-sized viewport (mobile plan §M2). Mirrors COMPACT_QUERY in
 *  chrome/compact.ts — the canvas fills the window, so the viewport the layout
 *  sees *is* the one the CSS media query tests, and the felt math and the DOM
 *  chrome flip to their compact forms together. */
export const COMPACT_MAX_W = 900;
export const COMPACT_MAX_H = 500;
export function isCompactViewport(viewport: Size): boolean {
  return viewport.w <= COMPACT_MAX_W || viewport.h <= COMPACT_MAX_H;
}

/** Height of the bottom band reserved for the hand. The camera fits the world
 *  into the viewport *above* this band, so every seat stays clear of the hand
 *  (design §13 exit criterion). Shared with the camera's safe area. */
export function handBandHeight(viewport: Size): number {
  // The 150px floor is a desktop floor: on a 390px-tall landscape phone it ate
  // 40% of the screen. Below ~600px tall it relaxes to a quarter of the height
  // (≈98px at 390) — cards stay readable through the inspect sheet (mobile §M2).
  // Continuous at the seam (0.25 × 600 = 150), so desktop sizes are unchanged.
  const floor = Math.min(150, viewport.h * 0.25);
  return Math.round(Math.max(floor, Math.min(300, viewport.h * 0.22)));
}

/** The hand fan + the stack pile, in screen (CSS-pixel) coordinates. `rightInset`
 *  is the width the open log sidebar steals from the right (§8): the hand centres
 *  in the felt *left* of it and the stack pins to that inset right edge, so nothing
 *  ever tucks under the panel. 0 ⇒ the whole viewport. `handOffset` is the hand
 *  fan's horizontal scroll in px (clamped here; ignored once the hand fits). */
export function layoutScreen(
  state: GameState, viewport: Size, rightInset = 0, spreadStack = false, handOffset = 0,
): PlacedActor[] {
  const out: PlacedActor[] = [];
  layoutHand(state, viewport, rightInset, handOffset, out);
  if (spreadStack) layoutStackSpread(state, viewport, rightInset, out);
  else layoutStack(state, viewport, rightInset, out);
  return out;
}

/** The hand fan's geometry — the scrollable-window numbers, with no cards in
 *  them. Pure and shared: `layoutHand` derives every card's placement from this,
 *  the scene clamps its wheel/arrow scroll against `maxOffset`/`step`, and the
 *  per-frame end-fade (`handFanAlphaAt`) reads `run`/`cardW`/`fadeLeft`/`fadeRight`
 *  — so all three agree by construction. Mirrors the carousel's `CarouselStrip`;
 *  the one difference is the hand keeps its fan curve (see `layoutHand`). */
export interface HandFan {
  /** Clamped scroll offset actually used, px from the fan's start. */
  offset: number;
  /** Largest useful offset. 0 ⇒ the whole hand fits and never scrolls. */
  maxOffset: number;
  /** Centre-to-centre spacing — one "card" of scroll, for the wheel and keys. */
  step: number;
  /** The reading window in screen px: at most HAND_VISIBLE cards wide, centred on
   *  the felt midline (the felt left of the log gutter, less a margin at each end
   *  when that is narrower). A hand longer than the window scrolls through it. */
  run: { left: number; width: number };
  /** One card's drawn width — the fade ramp measures itself in these. */
  cardW: number;
  /** Whether the fan continues past each end of the run right now (⇒ that edge
   *  dissolves). Both false when the whole hand fits. */
  fadeLeft: boolean;
  fadeRight: boolean;
}

/** The hand fan's window for `count` cards scrolled by `offset` px in `viewport`
 *  (with the log gutter `rightInset` reserved). */
export function layoutHandFan(
  count: number, offset: number, viewport: Size, rightInset = 0,
): HandFan {
  const band = handBandHeight(viewport);
  const scale = (band * 0.9) / CARD_TEX.h;          // card height ≈ 90% of the band
  const cardW = CARD_TEX.w * scale;
  const step = cardW * HAND_STEP_RATIO;
  const availW = Math.max(cardW + 2 * HAND_MARGIN, viewport.w - Math.max(0, rightInset));
  // Whatever the felt can spare, but never more than HAND_VISIBLE cards — a longer
  // hand scrolls *through* this run rather than stretching across the whole felt.
  const runW = Math.min(availW - 2 * HAND_MARGIN, step * (HAND_VISIBLE - 1) + cardW);
  const run = { left: (availW - runW) / 2, width: runW };
  if (count <= 0) {
    return { offset: 0, maxOffset: 0, step, run, cardW, fadeLeft: false, fadeRight: false };
  }
  const spanW = step * (count - 1) + cardW;
  const maxOffset = Math.max(0, spanW - runW);
  const o = Math.min(Math.max(0, offset), maxOffset);
  // An edge dissolves only while there is fan beyond it; the half-pixel guard keeps
  // a fully-scrolled fan from flickering its trailing edge on rounding.
  return {
    offset: o, maxOffset, step, run, cardW,
    fadeLeft: o > 0.5,
    fadeRight: o < maxOffset - 0.5,
  };
}

/** How opaque a hand card at screen-x `x` (its centre) should be: 1 well inside
 *  the run, ramping to 0 across HAND_FADE_CARDS at whichever end still has more
 *  fan behind it. Like `stripAlphaAt`, a function of the card's *live* x rather
 *  than a placement field — a card slides into the window over a scroll tween, and
 *  a placement alpha would light it up before it arrived. The scene calls this per
 *  frame from the actor's animated position. Pure, so the ramp is unit-testable. */
export function handFanAlphaAt(fan: HandFan, x: number): number {
  const fade = fan.cardW * HAND_FADE_CARDS;
  if (fade <= 0) return 1;
  const right = fan.run.left + fan.run.width;
  let a = 1;
  if (fan.fadeLeft) a = Math.min(a, (x - fan.run.left) / fade);
  if (fan.fadeRight) a = Math.min(a, (right - x) / fade);
  return a < 0 ? 0 : a > 1 ? 1 : a;
}

/** Your hand, fanned and centred along the bottom edge. Once it outgrows the run
 *  window it *scrolls* rather than cramming or paging (Issues.txt #8, modelled on
 *  the carousel strip): every card keeps a placement along one line — none is
 *  tucked away or culled, so drag-to-cast never sees anything unusual — and the
 *  ends of the run dissolve (`handFanAlphaAt`, applied per frame from the live x).
 *
 *  The fan curve stays: rotation and a downward arc grow with distance from the
 *  window centre (always the felt midline), so the middle card reads upright and
 *  the fan tilts toward both ends. Bounded by the run's half-width when the hand
 *  overflows, so a long hand never rotates its edge cards absurdly; the actual
 *  span when it fits, so a small hand still fans fully. */
function layoutHand(
  state: GameState, viewport: Size, rightInset: number, handOffset: number, out: PlacedActor[],
): void {
  const hand = state.me.hand;
  const n = hand.length;
  if (n === 0) return;

  const fan = layoutHandFan(n, handOffset, viewport, rightInset);
  const band = handBandHeight(viewport);
  const scale = (band * 0.9) / CARD_TEX.h;
  const availW = 2 * fan.run.left + fan.run.width;   // the felt width left of the gutter
  const spanW = fan.step * (n - 1) + fan.cardW;
  // Fits ⇒ centre it and never scroll; longer ⇒ pin to the run's left and slide by
  // the clamped offset, so the first card sits where the eye already is.
  const x0 = fan.maxOffset === 0
    ? (availW - spanW) / 2 + fan.cardW / 2
    : fan.run.left + fan.cardW / 2 - fan.offset;
  const centreX = availW / 2;
  const halfExtent = Math.max(1, Math.min(spanW, fan.run.width) / 2);
  const baseY = viewport.h - band / 2;

  hand.forEach((card, i) => {
    const x = x0 + i * fan.step;
    const t = Math.max(-1, Math.min(1, (x - centreX) / halfExtent));   // -1 … 1 across the fan
    const placement: ActorPlacement = {
      x,
      y: baseY + Math.abs(t) * band * HAND_ARC,      // slight downward arc at the ends
      rotation: t * HAND_MAX_ROT,
      scale,
      zone: 'hand',
      ownerId: state.me.playerId,
      faceUp: true,
    };
    out.push({ key: card.id, card, objectId: card.id, space: 'screen', placement });
  });
}

// ── the stack pile (design §7.1, T4) ────────────────────────────────────────────
//
// The stack reads as a *stack*, Arena-style: a right-edge pile where the **top of
// the stack** — the next thing to resolve — sits fully visible in front, and every
// item beneath it fans back to the left, showing only a sliver. New items land on
// top (in front), so a dozen triggers cost one pile's worth of screen, not a dozen
// cards' worth. The carousel that scrubs buried items forward is a later phase; for
// now the top is legible and the depth reads from the fan.

// XMage tags each selected mode of a modal spell on the stack with this prefix in
// the spell's rules (CardView: "Chosen mode: …"), so the chosen mode is legible
// even though the printed box lists them all. The bridge strips the HTML but keeps
// the line, so it rides through on StackItem.text.
const CHOSEN_MODE_PREFIX = 'Chosen mode:';

/** The effect text to lay over a stack card's text-box region — or undefined to
 *  leave the printed face untouched (design §9, T4). See `ActorPlacement.stackEffect`
 *  for the why: an ability's source card shows *all* its abilities and a modal
 *  spell's box shows *all* its modes, so we surface just what's on the stack — the
 *  triggered ability's own rules, or the chosen mode(s). A plain spell returns
 *  undefined (its printed box already is what resolves). */
export function stackEffectText(item: StackItem): { label: string; lines: string[] } | undefined {
  if (item.kind === 'ability') {
    return { label: 'ABILITY', lines: item.text.map(l => l.trim()).filter(l => l !== '') };
  }
  // A spell with an {X} in its cost has a chosen X on the stack (rule 202.3e leaves
  // it in the reported mana value); its printed box still shows a literal "X", so
  // fill the paid value into whatever text we surface for it.
  const x = chosenX(item.card?.manaCost, item.card?.manaValue ?? 0);
  const fill = (l: string) => (x !== undefined ? substituteX(l, x) : l);
  const chosen = item.text
    .filter(l => l.startsWith(CHOSEN_MODE_PREFIX))
    .map(l => fill(l.slice(CHOSEN_MODE_PREFIX.length).trim()))
    .filter(l => l !== '');
  if (chosen.length > 0) return { label: chosen.length > 1 ? 'MODES' : 'MODE', lines: chosen };
  // A plain spell keeps its printed face — except an X spell, whose face lies about
  // its cost: surface our own copy of the rules with X filled in so the table reads
  // the real number (Issues.txt: substitute X for X spells on the stack).
  if (x !== undefined) {
    const lines = item.text.map(l => fill(l.trim())).filter(l => l !== '');
    if (lines.length > 0) return { label: 'SPELL', lines };
  }
  return undefined;
}

const STACK_MARGIN = 30;             // right edge → front card
const STACK_MARGIN_COMPACT = 12;     // a phone has no pixels to spare at the edge
const STACK_SLIVER = 0.15;           // fraction of a card width each buried item shows
const STACK_SPAN_CARDS = 1;          // widest the fan ever spreads, in front-card widths
const STACK_DEPTH_CAP = 8;           // buried-item falloff saturates here (deep stacks)

/** Height of the stack's front card: a constant third of the viewport height, so
 *  the top of the stack reads at the same commanding size on every display —
 *  bounded by a quarter of the *width* too, which only bites on a tall-narrow
 *  screen (w < 1.32·h, i.e. a portrait phone), where a third of the height was a
 *  card so wide its gutter left the felt ~70px (mobile §M2). */
function stackFrontHeight(viewport: Size): number {
  return Math.round(Math.min(viewport.h * 0.33, viewport.w * 0.25));
}
const stackMargin = (viewport: Size): number =>
  isCompactViewport(viewport) ? STACK_MARGIN_COMPACT : STACK_MARGIN;

interface StackGeom { frontX: number; frontY: number; scale: number; cardW: number; step: number }

/** The shared right-edge geometry of the pile — one place computes the front-card
 *  centre and the per-item left step, so `layoutStack` and `stackAnchor` agree. */
function stackGeometry(viewport: Size, rightInset: number, n: number): StackGeom {
  const frontH = stackFrontHeight(viewport);
  const scale = frontH / CARD_TEX.h;
  const cardW = CARD_TEX.w * scale;
  const rightEdge = viewport.w - Math.max(0, rightInset);
  const frontX = rightEdge - stackMargin(viewport) - cardW / 2;
  // Centre the pile vertically in the play area (clear of the hand band below).
  const frontY = (viewport.h - handBandHeight(viewport)) / 2;
  // The fan steps left by a sliver per buried item, but never past its own strip:
  // the camera reserves exactly this pile's width (stackGutterWidth) so the felt
  // is framed beside it and never under it (#9), and a fan free to smear across
  // half the viewport would either re-cover the table or shove it off-screen. Past
  // ~seven items the slivers compress instead — depth still reads as "more of
  // them", which is all a buried sliver ever said.
  const baseStep = cardW * STACK_SLIVER;
  const maxSpan = Math.min(cardW * STACK_SPAN_CARDS, rightEdge - cardW - stackMargin(viewport));
  const step = Math.min(baseStep, maxSpan / Math.max(1, n - 1));
  return { frontX, frontY, scale, cardW, step };
}

/** The width the stack pile claims at the right edge, so the camera can frame the
 *  felt *beside* it instead of under it — the same reservation the open log gutter
 *  already gets (§8, camera.ts safeArea).
 *
 *  Issues.txt #9 and the 2026-07-31 "Aura Shards never let me target their Blind
 *  Obedience" both trace here: the pile is a screen-space surface drawn over the
 *  world, so every permanent beneath it was invisible *and* unclickable — the
 *  pointer hit the stack card instead. Measured on the demo table, a two-item
 *  stack already ate one or two board cards per camera view, and a stack is
 *  non-empty exactly when a target ask is on screen (the ask's own trigger is
 *  sitting there). Zero when the stack is empty, so the felt spreads back.
 *
 *  Covers the whole pile — front card, margins and every buried sliver — which is
 *  bounded because the fan's own spread is capped (STACK_SPAN_CARDS). It grows
 *  with the stack and shrinks back as it resolves, so the table makes room for a
 *  stack war and takes it back afterwards. */
export function stackGutterWidth(viewport: Size, stackSize: number): number {
  if (stackSize <= 0) return 0;
  const g = stackGeometry(viewport, 0, stackSize);
  return g.cardW + 2 * stackMargin(viewport) + (stackSize - 1) * g.step;
}

/** The screen point of the top-of-stack card's centre — where a trigger ghost
 *  should fly and where a source/target tether meets the pile (design §9, T4). */
export function stackAnchor(viewport: Size, rightInset = 0): Point {
  const g = stackGeometry(viewport, rightInset, 1);
  return { x: g.frontX, y: g.frontY };
}

function layoutStack(state: GameState, viewport: Size, rightInset: number, out: PlacedActor[]): void {
  const items = state.stack;
  const n = items.length;
  if (n === 0) return;

  const { frontX, frontY, scale, step } = stackGeometry(viewport, rightInset, n);

  items.forEach((item, i) => {
    // depth: 0 for the top (front), growing as we descend toward the oldest item.
    const depth = n - 1 - i;
    const d = Math.min(depth, STACK_DEPTH_CAP);
    const effect = stackEffectText(item);
    out.push({
      key: item.id, card: item.card, objectId: item.card?.id, space: 'screen',
      placement: {
        x: frontX - depth * step,
        y: frontY + d * 5,                 // gentle downward-left arc, like a held fan
        rotation: -d * 0.02,
        scale: scale * (1 - d * 0.02),     // buried items read a touch smaller
        zone: 'stack',
        ownerId: item.controllerId,
        faceUp: true,
        ...(effect ? { stackEffect: effect } : {}),
      },
    });
  });
}

// When a prompt asks you to target a stack item (counter/copy/redirect target
// spell or ability), the collapsed fan hides everything but the top card — you
// can't click a buried candidate. The pile un-fans into a centred row so every
// item is separated and individually hittable, then re-collapses when the prompt
// clears (design §7 T4, mirroring Arena's target-a-spell spread).
function layoutStackSpread(state: GameState, viewport: Size, rightInset: number, out: PlacedActor[]): void {
  const items = state.stack;
  const n = items.length;
  if (n === 0) return;

  // A readable card, sized so the whole spread fits the felt width left of the log.
  const availW = viewport.w - Math.max(0, rightInset);
  const band = handBandHeight(viewport);
  const wantH = Math.min(280, (viewport.h - band) * 0.4);
  let scale = wantH / CARD_TEX.h;
  let cardW = CARD_TEX.w * scale;
  const gap = cardW * 0.18;
  const margin = 40;
  const spanW = n * cardW + (n - 1) * gap;
  if (spanW > availW - 2 * margin) {                 // shrink to fit a deep stack
    scale *= (availW - 2 * margin) / spanW;
    cardW = CARD_TEX.w * scale;
  }
  const stepX = cardW + cardW * 0.18;
  const totalW = (n - 1) * stepX;
  const cx = availW / 2;
  const cy = (viewport.h - band) / 2;

  items.forEach((item, i) => {
    const effect = stackEffectText(item);
    out.push({
      key: item.id, card: item.card, objectId: item.card?.id, space: 'screen',
      placement: {
        x: cx - totalW / 2 + i * stepX,
        y: cy,
        rotation: 0,
        scale,
        zone: 'stack',
        ownerId: item.controllerId,
        faceUp: true,
        ...(effect ? { stackEffect: effect } : {}),
      },
    });
  });
}
