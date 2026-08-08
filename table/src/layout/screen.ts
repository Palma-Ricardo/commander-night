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
import { HAND_PAGE_SIZE, HAND_PAGE_THRESHOLD } from '../tuning';
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
 *  ever tucks under the panel. 0 ⇒ the whole viewport. `handPage` is the §4.4
 *  hand-mode page (clamped here; only read when the hand is oversized). */
export function layoutScreen(
  state: GameState, viewport: Size, rightInset = 0, spreadStack = false, handPage = 0,
): PlacedActor[] {
  const out: PlacedActor[] = [];
  layoutHand(state, viewport, rightInset, handPage, out);
  if (spreadStack) layoutStackSpread(state, viewport, rightInset, out);
  else layoutStack(state, viewport, rightInset, out);
  return out;
}

/** Pages an oversized hand fans through (1 ⇒ the whole hand fits one fan). */
export function handPageCount(handSize: number): number {
  if (handSize <= HAND_PAGE_THRESHOLD) return 1;
  return Math.max(1, Math.ceil(handSize / HAND_PAGE_SIZE));
}

/** Your hand, fanned and centred along the bottom edge. Past
 *  HAND_PAGE_THRESHOLD it pages instead of cramming (§4.4 hand mode): only the
 *  current page fans in the band; off-page cards are placed just below the
 *  bottom edge on their page's side, so a page turn slides them in and out as
 *  ordinary actor tweens and drag-to-cast never sees anything unusual. */
function layoutHand(
  state: GameState, viewport: Size, rightInset: number, handPage: number, out: PlacedActor[],
): void {
  const hand = state.me.hand;
  const total = hand.length;
  if (total === 0) return;

  const pages = handPageCount(total);
  const page = Math.min(Math.max(0, handPage), pages - 1);
  const start = pages > 1 ? page * HAND_PAGE_SIZE : 0;
  const end = pages > 1 ? Math.min(total, start + HAND_PAGE_SIZE) : total;
  const n = end - start;

  const band = handBandHeight(viewport);
  const scale = (band * 0.9) / CARD_TEX.h;         // card height ≈ 90% of the band
  const cardW = CARD_TEX.w * scale;
  const overlap = 0.62;                            // fan cards overlap when crowded
  const availW = Math.max(cardW + 48, viewport.w - Math.max(0, rightInset));
  const step = Math.min(cardW * overlap, (availW - cardW - 48) / Math.max(1, n - 1));
  const spanW = step * (n - 1);
  const startX = availW / 2 - spanW / 2;
  const baseY = viewport.h - band / 2;
  const hiddenY = viewport.h + (band * 0.9) / 2 + 8;   // fully below the bottom edge

  hand.forEach((card, i) => {
    const onPage = i >= start && i < end;
    const j = i - start;
    const t = onPage && n > 1 ? j / (n - 1) - 0.5 : 0;   // -0.5 … 0.5 across the fan
    out.push({
      key: card.id, card, objectId: card.id, space: 'screen',
      placement: onPage
        ? {
            x: startX + j * step,
            y: baseY + Math.abs(t) * band * 0.10,        // slight downward arc at the ends
            rotation: t * 0.1,
            scale,
            zone: 'hand',
            ownerId: state.me.playerId,
            faceUp: true,
          }
        : {
            // Tucked out of sight on its page's side: earlier pages exit left,
            // later ones right, so a turn reads as the fan sliding through.
            x: i < start ? startX - cardW : startX + spanW + cardW,
            y: hiddenY,
            rotation: 0,
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
const STACK_SLIVER = 0.15;           // fraction of a card width each buried item shows
const STACK_SPAN_CARDS = 1;          // widest the fan ever spreads, in front-card widths
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
  // The fan steps left by a sliver per buried item, but never past its own strip:
  // the camera reserves exactly this pile's width (stackGutterWidth) so the felt
  // is framed beside it and never under it (#9), and a fan free to smear across
  // half the viewport would either re-cover the table or shove it off-screen. Past
  // ~seven items the slivers compress instead — depth still reads as "more of
  // them", which is all a buried sliver ever said.
  const baseStep = cardW * STACK_SLIVER;
  const maxSpan = Math.min(cardW * STACK_SPAN_CARDS, rightEdge - cardW - STACK_MARGIN);
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
  return g.cardW + 2 * STACK_MARGIN + (stackSize - 1) * g.step;
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
