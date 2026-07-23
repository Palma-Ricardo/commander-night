// Actor-key canonicalization (design §3, §6.1) — pure, headless. Almost every
// actor is keyed by its stable object UUID, which is what makes a card one
// persistent actor across hand ↔ battlefield ↔ graveyard ↔ exile: the same key
// appears in the layout of both the before- and after-states, so the director
// tweens it rather than destroying and recreating it (zero teleport).
//
// The stack is the sole exception (§3): XMage keys a spell on the stack by an
// **ephemeral** stack id, so `layoutStack` emits stack actors keyed by that id.
// The M6 `stackLink { stackId, objectId }` event binds the ephemeral id to the
// stable card it came from; adopting the stack actor's key onto the stable id
// unifies the cast → resolve → ETB chain onto one actor. Without it a cast would
// pop a new actor onto the stack (teleport out of the hand) and resolve would pop
// another onto the battlefield.

import type { GameEvent, GameState } from '@night/core';
import type { PlacedActor } from '../layout/types';
import { layoutWorld } from '../layout/world';
import { layoutScreen } from '../layout/screen';
import type { Size } from '../layout/types';

/** ephemeral stack id → stable card/source id (§3). */
export type StackLinks = Map<string, string>;

/** Fold every `stackLink` event in a transition into `links` (mutates + returns
 *  it). Bindings accumulate; `pruneStackLinks` drops them once resolved. */
export function accumulateStackLinks(links: StackLinks, events: readonly GameEvent[]): StackLinks {
  for (const e of events) {
    if (e.k === 'stackLink') links.set(e.stackId, e.objectId);
  }
  return links;
}

/** Drop links whose stack item has left the stack (resolved/countered): its
 *  ephemeral id is dead and will never key an actor again, so keeping it would
 *  only grow the map and risk a stale collision. */
export function pruneStackLinks(links: StackLinks, state: GameState): void {
  const live = new Set(state.stack.map(s => s.id));
  for (const stackId of [...links.keys()]) if (!live.has(stackId)) links.delete(stackId);
}

/** The stable actor key for a raw layout key: the linked object id for a stack
 *  actor, else the key unchanged. */
export function canonicalKey(rawKey: string, links: StackLinks): string {
  return links.get(rawKey) ?? rawKey;
}

/** `layoutWorld` + `layoutScreen` with stack-actor keys canonicalized onto their
 *  stable object id, indexed by that key. The single source of truth for both
 *  the director's diff and the continuity assertions. */
export function layoutKeyed(
  state: GameState, viewport: Size, links: StackLinks, rightInset = 0,
): Map<string, PlacedActor> {
  const out = new Map<string, PlacedActor>();
  for (const p of layoutWorld(state)) out.set(canonicalKey(p.key, links), { ...p, key: canonicalKey(p.key, links) });
  for (const p of layoutScreen(state, viewport, rightInset)) out.set(p.key, p);   // hand keys are already stable ids
  return out;
}
