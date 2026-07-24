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
import type { PlacedActor, Point, Size } from './types';

const CARD_TEX = { w: 200, h: 280 } as const;

/** Height of the bottom band reserved for the hand. The camera fits the world
 *  into the viewport *above* this band, so every seat stays clear of the hand
 *  (design §13 exit criterion). Shared with the camera's safe area. */
export function handBandHeight(viewport: Size): number {
  return Math.max(150, Math.min(300, Math.round(viewport.h * 0.22)));
}

/** The hand fan + the stack pile, in screen (CSS-pixel) coordinates. `rightInset`
 *  is the width the open log sidebar steals from the right (§8): the hand centres
 *  in the felt *left* of it and the stack pins to that inset right edge, so nothing
 *  ever tucks under the panel. 0 ⇒ the whole viewport. */
export function layoutScreen(state: GameState, viewport: Size, rightInset = 0, spreadStack = false): PlacedActor[] {
  const out: PlacedActor[] = [];
  layoutHand(state, viewport, rightInset, out);
  if (spreadStack) layoutStackSpread(state, viewport, rightInset, out);
  else layoutStack(state, viewport, rightInset, out);
  return out;
}

/** Your hand, fanned and centred along the bottom edge. */
function layoutHand(state: GameState, viewport: Size, rightInset: number, out: PlacedActor[]): void {
  const hand = state.me.hand;
  const n = hand.length;
  if (n === 0) return;

  const band = handBandHeight(viewport);
  const scale = (band * 0.9) / CARD_TEX.h;         // card height ≈ 90% of the band
  const cardW = CARD_TEX.w * scale;
  const overlap = 0.62;                            // fan cards overlap when crowded
  const availW = Math.max(cardW + 48, viewport.w - Math.max(0, rightInset));
  const step = Math.min(cardW * overlap, (availW - cardW - 48) / Math.max(1, n - 1));
  const spanW = step * (n - 1);
  const startX = availW / 2 - spanW / 2;
  const baseY = viewport.h - band / 2;

  hand.forEach((card, i) => {
    const t = n > 1 ? i / (n - 1) - 0.5 : 0;       // -0.5 … 0.5 across the fan
    out.push({
      key: card.id, card, objectId: card.id, space: 'screen',
      placement: {
        x: startX + i * step,
        y: baseY + Math.abs(t) * band * 0.10,      // slight downward arc at the ends
        rotation: t * 0.1,
        scale,
        zone: 'hand',
        ownerId: state.me.playerId,
        faceUp: true,
      },
    });
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
  const chosen = item.text
    .filter(l => l.startsWith(CHOSEN_MODE_PREFIX))
    .map(l => l.slice(CHOSEN_MODE_PREFIX.length).trim())
    .filter(l => l !== '');
  if (chosen.length === 0) return undefined;
  return { label: chosen.length > 1 ? 'MODES' : 'MODE', lines: chosen };
}

const STACK_MARGIN = 30;             // right edge → front card
const STACK_SLIVER = 0.15;           // fraction of a card width each buried item shows
const STACK_DEPTH_CAP = 8;           // buried-item falloff saturates here (deep stacks)

/** Height of the stack's front card: a constant third of the viewport height, so
 *  the top of the stack reads at the same commanding size on every display. */
function stackFrontHeight(viewport: Size): number {
  return Math.round(viewport.h * 0.33);
}

interface StackGeom { frontX: number; frontY: number; scale: number; cardW: number; step: number }

/** The shared right-edge geometry of the pile — one place computes the front-card
 *  centre and the per-item left step, so `layoutStack` and `stackAnchor` agree. */
function stackGeometry(viewport: Size, rightInset: number, n: number): StackGeom {
  const frontH = stackFrontHeight(viewport);
  const scale = frontH / CARD_TEX.h;
  const cardW = CARD_TEX.w * scale;
  const rightEdge = viewport.w - Math.max(0, rightInset);
  const frontX = rightEdge - STACK_MARGIN - cardW / 2;
  // Centre the pile vertically in the play area (clear of the hand band below).
  const frontY = (viewport.h - handBandHeight(viewport)) / 2;
  // The fan steps left by a sliver per buried item, but never so far that a deep
  // stack runs off into the centre of the table: cap the total spread at ~45% of
  // the felt width and shrink the step to fit.
  const baseStep = cardW * STACK_SLIVER;
  const maxSpan = Math.min(viewport.w * 0.45, rightEdge - cardW - STACK_MARGIN);
  const step = Math.min(baseStep, maxSpan / Math.max(1, n - 1));
  return { frontX, frontY, scale, cardW, step };
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
