// Semantic test harness (table-client design §12) — the `window.__night` surface
// the Playwright auto-player drives. Brought forward from T5 to T0 (Ricardo,
// 2026-07-22) so the table client exposes a Playwright-legible contract from its
// first commit rather than being retrofitted after T4: a canvas table is opaque
// to CSS-selector driving, so the auto-player must express game intent
// (`click(objectId)`, `answer(...)`, `pass()`) and read a `scene()` of actor
// keys/positions instead of DOM structure. The same specs then run against both
// clients — the classic client implements this too, as the reference.
//
// The view-independent half (snapshot + the semantic actions, all backed by the
// shared stores/actions) lives here so both clients get identical behavior. Only
// `scene()` is client-provided: the classic client derives it from state, the
// table client reads it from its Pixi actors + camera.

import type { createActions } from './net/actions';
import type { AnswerValue, GameState, Id, Prompt, Zone } from './protocol/protocol';
import type { SocketStatus } from './stores/connection';
import type { Stores } from './stores';

type Actions = ReturnType<typeof createActions>;

/** Read-only sync-health + current-prompt view (design §6/§13). The auto-player
 *  drives through the semantic actions below and asserts progress through this. */
export interface NightSnapshot {
  gameId: string | null;
  over: boolean;
  syncMode: 'live' | 'awaitingKeyframe';
  lastAppliedSeq: number;
  counters: { patches: number; keyframes: number; resyncs: number; verifies: number; divergences: number };
  promptId: number | null;
  promptKind: string | null;
  /** payMana only: the remaining cost — re-asks mint fresh promptIds, so this
   *  is the auto-player's real progress signal for payment loops. */
  payRemaining: string | null;
  combatRole: 'attackers' | 'blockers' | null;
  inflight: boolean;
  turn: number | null;
  /** Players the state knows about — the view-independent "the board is up"
   *  signal (T5). The classic client counted `.seat-panel` DOM nodes; the table
   *  client's seats are canvas furniture, so the specs read this instead. */
  seats: number;
  /** The socket's own state (§11). Without it a driver cannot tell "the game is
   *  slow" from "this seat has no connection": both look like `promptId === null`,
   *  and the stuck detector only watches a *pending* prompt, so a dead socket used
   *  to spin silently until the game deadline. Live-caught 2026-07-24 when the dev
   *  server died mid-run and the specs kept polling for another 8 minutes. */
  socket: SocketStatus;
}

/** The pending prompt exactly as the wire sent it (protocol §8), plus the
 *  interaction scratch around it. Added at T5: the auto-player used to read the
 *  dock's DOM to learn what a prompt offered (option keys, distribute rows, pool
 *  colours, combat candidates). A canvas client renders none of that on the
 *  board, and the dock is not where game meaning lives anyway — so the driver
 *  now computes a first-legal answer from the protocol data itself and submits it
 *  through the semantic actions below. */
export interface NightPromptView {
  pending: Prompt;
  /** chooseTargets accumulation, in click order (§7). */
  selected: Id[];
  /** payMana sources a click provably didn't progress payment through (§7). */
  cantPay: Id[];
  /** my floating mana pool — payMana spends the pool before tapping sources. */
  pool: { W: number; U: number; B: number; R: number; G: number; C: number } | undefined;
}

/** One rendered object, keyed by its stable actor key (§6.1). Positions are
 *  world coordinates for the table client; the classic client, which has no
 *  canvas, reports zone membership with zeroed positions. */
export interface SceneActor {
  key: string;
  objectId?: Id;
  zone: Zone;
  ownerId?: Id;
  x: number;
  y: number;
  faceUp: boolean;
  /** the director is mid-animation on this actor (table client only). */
  animating: boolean;
}

export interface NightScene {
  actors: SceneActor[];
  camera?: { view: string; x: number; y: number; scale: number };
  /** any actor is mid-flight — the auto-player's "board caught up" signal. */
  animating: boolean;
}

/** The half of the harness only the view can answer (§12). `scene()` reads the
 *  rendered actors; `highlights()` reports which objects the view is actually
 *  offering as clickable — the canvas-capable form of §13's no-dead-end
 *  invariant, which the classic client used to prove with a `.hl-*` DOM count. */
export interface NightHarnessView {
  scene(): NightScene;
  highlights(): Id[];
}

/** What `window.__night` exposes. Both clients implement it; the driver types
 *  against this and never against a client's internals. */
export interface NightHarness extends NightHarnessView {
  snapshot(): NightSnapshot;
  /** The pending prompt itself, for computing a legal answer (T5). */
  prompt(): NightPromptView | null;
  /** Submit an arbitrary answer to the current prompt (multi-target submit,
   *  option key, number, pile, distribution, cancel…).
   *
   *  `promptId` is the id the caller decided its answer *for*: pass it and a
   *  supersede between deciding and submitting drops the answer instead of
   *  misapplying it to the new prompt (§7 stale-click rule). The dock gets this
   *  for free by capturing the id it rendered with; a semantic caller has to say
   *  so. Omit it to answer whatever is pending, as a live click does. */
  answer(value: AnswerValue, promptId?: number): void;
  /** Pass priority / decline (confirm=false) on the current prompt. */
  pass(promptId?: number): void;
  /** Interact semantically with an object, dispatched on the pending prompt
   *  kind: declare in combat, toggle a target, click a mana source, pick an
   *  ability. The board affordance without the CSS. */
  click(objectId: Id, promptId?: number): void;
}

declare global {
  interface Window {
    __night?: NightHarness;
  }
}

/** The view-independent half: snapshot, the pending prompt, and the semantic
 *  actions, all backed by the shared stores/actions. The `NightHarnessView` half
 *  is supplied per-client by installHarness(). */
export function createCoreHarness(
  stores: Stores,
  actions: Actions,
): Omit<NightHarness, keyof NightHarnessView> {
  const snapshot = (): NightSnapshot => {
    const g = stores.game.getState();
    const p = stores.prompt.getState();
    return {
      gameId: g.state?.gameId ?? null,
      over: g.over !== undefined,
      syncMode: g.syncMode,
      lastAppliedSeq: g.lastAppliedSeq,
      counters: { ...g.counters },
      promptId: p.pending?.promptId ?? null,
      promptKind: p.pending?.kind ?? null,
      payRemaining: p.pending?.kind === 'payMana' ? p.pending.remaining : null,
      combatRole: p.pending?.kind === 'priority' ? p.pending.combat?.role ?? null : null,
      inflight: p.inflight,
      turn: g.state?.turn.n ?? null,
      seats: g.state?.players.length ?? 0,
      socket: stores.connection.getState().status,
    };
  };

  return {
    snapshot,

    prompt(): NightPromptView | null {
      const p = stores.prompt.getState();
      if (p.pending === undefined) return null;
      const state = stores.game.getState().state;
      return {
        pending: p.pending,
        selected: [...p.selected],
        cantPay: [...p.cantPay],
        pool: state === undefined ? undefined
          : state.players.find(pl => pl.id === state.me.playerId)?.manaPool,
      };
    },

    // Every action funnels its promptId through the core actions, which drop a
    // submit whose id is no longer pending — so an explicit `promptId` makes a
    // stale answer a no-op rather than a wrong answer to the next prompt.
    answer(value: AnswerValue, promptId?: number): void {
      const id = promptId ?? stores.prompt.getState().pending?.promptId;
      if (id !== undefined) void actions.answerPrompt(id, value);
    },

    pass(promptId?: number): void {
      const id = promptId ?? stores.prompt.getState().pending?.promptId;
      if (id !== undefined) void actions.answerPrompt(id, { type: 'confirm', value: false });
    },

    click(objectId: Id, promptId?: number): void {
      const pending = stores.prompt.getState().pending;
      if (pending === undefined || (promptId !== undefined && pending.promptId !== promptId)) return;
      const id = pending.promptId;
      switch (pending.kind) {
        case 'chooseTargets':
          // mirrors a board click exactly (client interact.ts): a single-target
          // pick answers in one click (§8 allows {object} one-at-a-time), a
          // multi-target pick accumulates scratch and is submitted whole (§7).
          if (pending.max === 1) void actions.answerPrompt(id, { type: 'object', objectId });
          else actions.toggleTarget(id, objectId);
          break;
        case 'payMana':
          void actions.clickManaSource(id, objectId);
          break;
        // priority (declare an attacker/blocker), chooseAbility, and the generic
        // "act on this object" all submit an object answer (§8).
        default:
          void actions.answerPrompt(id, { type: 'object', objectId });
      }
    },
  };
}

/** A `scene()` derived purely from `GameState`, with zeroed positions. The
 *  classic client (no canvas) uses this directly; the table client renders real
 *  world positions from its actors and only falls back here before its first
 *  layout. Enumerates every object the trimmed state names, plus opponent hands
 *  as face-down actors (the count is public — §7.2). */
export function sceneFromState(state: GameState | undefined): NightScene {
  const actors: SceneActor[] = [];
  if (state === undefined) return { actors, animating: false };

  const push = (key: string, zone: Zone, faceUp: boolean, objectId?: Id, ownerId?: Id): void => {
    actors.push({ key, objectId, zone, ownerId, x: 0, y: 0, faceUp, animating: false });
  };

  for (const c of state.me.hand) push(c.id, 'hand', true, c.id, state.me.playerId);

  for (const pl of state.players) {
    for (const perm of pl.battlefield) push(perm.id, 'battlefield', !(perm.faceDown ?? false), perm.id, pl.id);
    for (const c of pl.graveyard) push(c.id, 'graveyard', true, c.id, pl.id);
    for (const c of pl.exile) push(c.id, 'exile', true, c.id, pl.id);
    for (const c of pl.commandZone) push(c.id, 'command', true, c.id, pl.id);
    // opponent hands: face-down backs, keyed synthetically (no stable id — hidden)
    if (pl.id !== state.me.playerId) {
      for (let i = 0; i < pl.handSize; i++) push(`${pl.id}:hand:${i}`, 'hand', false, undefined, pl.id);
    }
  }

  for (const s of state.stack) push(s.id, 'stack', true, s.card?.id, s.controllerId);

  return { actors, animating: false };
}

/** Assemble `window.__night` from the shared core + the client-supplied view
 *  half, gated on the harness flag so production builds ship no handle. */
export function installHarness(
  win: Window,
  core: Omit<NightHarness, keyof NightHarnessView>,
  view: NightHarnessView,
): void {
  win.__night = { ...core, ...view };
}
