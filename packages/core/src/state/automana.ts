// The auto-mana solver (prompts-on-the-table §6). XMage's server-side
// auto-payment eats the unambiguous cases; what surfaces as `payMana` is the
// residue, and most of the residue is still solvable. This module answers it:
// floating pool spends first (it is otherwise lost), then a small backtracking
// cover over sources×pips. One click per re-ask, strictly sequential — each
// re-ask mints a fresh promptId and the solver re-plans from the new
// `remaining`, never scripting N clicks ahead, which also keeps it correct
// when XMage's own auto-payment eats part of the cost mid-stream.
//
// Preference rules (locked 2026-07-25): colored pips draw from the source with
// the smallest production set that covers them (basics before duals, so
// flexible sources stay untapped); generic pips draw from colorless-only
// sources first, then the least-flexible remainder. Above both rules,
// creatures are last-resort sources (see SourceInfo.creature). Overshoot is
// allowed — a multi-mana source may be tapped past what remains; the remainder
// floats and is spent first on the next ask. Minimizing overshoot is a
// tie-break only.
//
// It stands down — leaving the §5.3 manual panel up — when any pip is not
// plainly coverable (snow, unparseable symbols), when the readable sources +
// pool can't cover `remaining` at all, or after a no-progress click (re-plan
// once on the cantPay badge, then stop rather than loop). It never sends
// Cancel, and it never answers the "mana will be lost" confirm — that renders
// on the corner cluster and is the player's call.

import type { Card, GameState, Id, Prompt } from '../protocol/protocol';
import type { Stores } from '../stores';
import { findObject, me } from './selectors';
import { parseManaCost } from './mana';

export type PoolColor = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';
const POOL_COLORS: PoolColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];

/** The parsed residual cost: colored pips (each a set of acceptable produced
 *  symbols — {G}→{G}, {W/U}→{W,U}, {G/P}→{G}, {C}→{C}) plus a generic count. */
export interface Pips {
  colored: Set<PoolColor>[];
  generic: number;
}

/** Parse a `remaining` cost into pips, or undefined when any symbol is not
 *  plainly coverable by mana (snow, unannounced {X}, {2/W}, …) — the solver
 *  stands down rather than guess. Phyrexian halves ({G/P}) are treated as
 *  their colored half: the solver pays mana, never life. */
export function parseRemaining(remaining: string): Pips | undefined {
  const pips: Pips = { colored: [], generic: 0 };
  for (const sym of parseManaCost(remaining)) {
    if (/^\d+$/.test(sym)) { pips.generic += Number(sym); continue; }
    const parts = sym.split('/');
    if (parts.length === 1 && isPoolColor(parts[0]!)) {
      pips.colored.push(new Set([parts[0] as PoolColor]));
    } else if (parts.length === 2 && parts[1] === 'P' && isColor(parts[0]!)) {
      pips.colored.push(new Set([parts[0] as PoolColor]));
    } else if (parts.length === 2 && isColor(parts[0]!) && isColor(parts[1]!)) {
      pips.colored.push(new Set([parts[0] as PoolColor, parts[1] as PoolColor]));
    } else {
      return undefined;   // {S}, {X}, {2/W}, anything unrecognized
    }
  }
  return pips;
}

function isColor(s: string): boolean {
  return s === 'W' || s === 'U' || s === 'B' || s === 'R' || s === 'G';
}
function isPoolColor(s: string): boolean {
  return isColor(s) || s === 'C';
}

// ── source production ────────────────────────────────────────────────────────

/** What one activation of a source can produce: a list of alternatives, each a
 *  multiset of symbols (Forest → [[G]]; Tundra → [[W],[U]]; Sol Ring →
 *  [[C,C]]; any-color → [[W],[U],[B],[R],[G]]). */
export type Production = PoolColor[][];

const BASIC_TYPES: Record<string, PoolColor> = {
  plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G',
};

/** A production line the solver can plan on: a bare "{T}: Add …" with no
 *  additional cost (sacrifice-cost lines are skipped — spending the source is
 *  not the solver's call) and a fully-understood Add clause. */
const TAP_ADD = /^\(?\{T\}\s*:\s*Add\s+(.+?)\.?\)?$/i;
const ANY_COLOR = /^one mana of any color$/i;
const COMMANDER_COLOR = /^one mana of any color in your commander'?s color identity$/i;

/** Read a source's producible mana from its visible card, or undefined when
 *  nothing is readable (the source is excluded from planning; if the plan
 *  can't cover without it, the solver stands down). `commanderColors` powers
 *  the Command Tower wording — a card's colors are always within its color
 *  identity, so planning on them can never plan the unproducible. */
export function sourceProduction(card: Card, commanderColors: PoolColor[] = []): Production | undefined {
  const alts: PoolColor[][] = [];
  for (const sub of card.subtypes) {
    const c = BASIC_TYPES[sub.toLowerCase()];
    if (c !== undefined) alts.push([c]);
  }
  for (const line of card.text) {
    const m = TAP_ADD.exec(line.trim());
    if (m === null) continue;
    for (const alt of parseAddClause(m[1]!, commanderColors) ?? []) alts.push(alt);
  }
  // dedupe identical alternatives (a Tundra's subtypes need no text help)
  const seen = new Set<string>();
  const unique = alts.filter(a => {
    const key = [...a].sort().join('');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.length > 0 ? unique : undefined;
}

/** The clause after "Add", split on " or " into alternatives; each must be a
 *  pure run of symbols or a known any-color phrase — leftover words make the
 *  clause unreadable ("Add {C} for each…" plans nothing). */
function parseAddClause(clause: string, commanderColors: PoolColor[]): Production | undefined {
  const out: PoolColor[][] = [];
  for (const alt of clause.split(/\s+or\s+/i)) {
    const t = alt.trim().replace(/,$/, '');
    if (ANY_COLOR.test(t)) { out.push(...(['W', 'U', 'B', 'R', 'G'] as PoolColor[]).map(c => [c])); continue; }
    if (COMMANDER_COLOR.test(t)) {
      if (commanderColors.length === 0) return undefined;
      out.push(...commanderColors.map(c => [c]));
      continue;
    }
    if (!/^(\{[WUBRGC]\})+$/.test(t)) return undefined;
    out.push(parseManaCost(t).filter(isPoolColor) as PoolColor[]);
  }
  return out;
}

// ── the planner ──────────────────────────────────────────────────────────────

export interface SourceInfo {
  id: Id;
  alts: Production;
  /** Creatures are last-resort sources — tapping one costs an attacker/blocker,
   *  so every non-creature provider is tried first (live-learned 2026-07-25:
   *  Rishkar grants countered creatures "{T}: Add {G}", and a production-set
   *  ranking alone tapped the whole team out of combat every turn). */
  creature?: boolean;
}

export type PayStep =
  | { kind: 'pool'; color: PoolColor }
  | { kind: 'tap'; id: Id };

/** Plan a full cover of `pips` from the pool plus the readable sources, or
 *  undefined when they can't cover it. The returned steps are ordered pool
 *  spends first, then taps — but only steps[0] is ever executed; every re-ask
 *  re-plans from the fresh `remaining`. */
export function planPayment(
  pips: Pips,
  pool: Record<PoolColor, number>,
  sources: SourceInfo[],
): PayStep[] | undefined {
  // Most-constrained colored pips first, so a pool W lands on {W} before a
  // hybrid or generic claims it.
  const colored = [...pips.colored].sort((a, b) => a.size - b.size);
  const flexibility = (s: SourceInfo): number =>
    new Set(s.alts.flat().filter(c => c !== 'C')).size;
  const creatureLast = (a: SourceInfo, b: SourceInfo): number =>
    Number(a.creature ?? false) - Number(b.creature ?? false);

  interface Assign { poolSpends: PoolColor[]; taps: { id: Id; alt: PoolColor[] }[] }

  const poolLeft: Record<PoolColor, number> = { ...pool };
  const used = new Set<Id>();
  const leftovers: PoolColor[] = [];   // overshoot from taps, free for later pips
  const assign: Assign = { poolSpends: [], taps: [] };

  const coverColored = (i: number): boolean => {
    if (i === colored.length) return coverGeneric();
    const pip = colored[i]!;
    // pool first — floating mana is otherwise lost
    for (const c of POOL_COLORS) {
      if (!pip.has(c) || poolLeft[c] <= 0) continue;
      poolLeft[c]--; assign.poolSpends.push(c);
      if (coverColored(i + 1)) return true;
      poolLeft[c]++; assign.poolSpends.pop();
    }
    // then overshoot already floating in the plan
    for (let l = 0; l < leftovers.length; l++) {
      if (!pip.has(leftovers[l]!)) continue;
      const [c] = leftovers.splice(l, 1);
      if (coverColored(i + 1)) return true;
      leftovers.splice(l, 0, c!);
    }
    // then a fresh tap: non-creatures first, then smallest production set
    const candidates = sources
      .filter(s => !used.has(s.id) && s.alts.some(a => a.some(c => pip.has(c))))
      .sort((a, b) => creatureLast(a, b) || flexibility(a) - flexibility(b));
    for (const s of candidates) {
      for (const alt of s.alts) {
        const hit = alt.findIndex(c => pip.has(c));
        if (hit < 0) continue;
        used.add(s.id); assign.taps.push({ id: s.id, alt });
        const spill = alt.filter((_, idx) => idx !== hit);
        leftovers.push(...spill);
        if (coverColored(i + 1)) return true;
        leftovers.splice(leftovers.length - spill.length, spill.length);
        assign.taps.pop(); used.delete(s.id);
      }
    }
    return false;
  };

  const coverGeneric = (): boolean => {
    // Leaf of the colored backtracking — snapshot so a failed attempt leaves
    // no residue in the caller's retries.
    const savedPool = { ...poolLeft };
    const savedSpends = assign.poolSpends.length;
    const savedTaps = assign.taps.length;
    const tappedHere: Id[] = [];

    let need = pips.generic;
    // free overshoot, then pool (any color), then fresh taps
    need -= leftovers.length;
    for (const c of POOL_COLORS) {
      while (need > 0 && poolLeft[c] > 0) { poolLeft[c]--; assign.poolSpends.push(c); need--; }
    }
    if (need > 0) {
      // non-creatures first, then colorless-only, then least flexible;
      // overshoot as tie-break
      const candidates = sources
        .filter(s => !used.has(s.id))
        .map(s => ({ s, alt: bestGenericAlt(s.alts, need) }))
        .sort((a, b) =>
          creatureLast(a.s, b.s)
          || flexibility(a.s) - flexibility(b.s)
          || overshoot(a.alt, need) - overshoot(b.alt, need)
          || b.alt.length - a.alt.length);   // fewer clicks when overshoot ties
      for (const { s, alt } of candidates) {
        if (need <= 0) break;
        used.add(s.id); tappedHere.push(s.id); assign.taps.push({ id: s.id, alt });
        need -= alt.length;
      }
    }
    if (need <= 0) return true;
    Object.assign(poolLeft, savedPool);
    assign.poolSpends.length = savedSpends;
    assign.taps.length = savedTaps;
    for (const id of tappedHere) used.delete(id);
    return false;
  };

  if (!coverColored(0)) return undefined;
  return [
    ...assign.poolSpends.map(color => ({ kind: 'pool', color }) as PayStep),
    ...assign.taps.map(t => ({ kind: 'tap', id: t.id }) as PayStep),
  ];
}

const bestGenericAlt = (alts: Production, need: number): PoolColor[] =>
  [...alts].sort((a, b) => overshoot(a, need) - overshoot(b, need) || b.length - a.length)[0]!;
const overshoot = (alt: PoolColor[], need: number): number => Math.max(0, alt.length - need);

// ── the per-ask decision ─────────────────────────────────────────────────────

export type AutoManaDecision =
  | { act: 'pool'; color: PoolColor }
  | { act: 'tap'; sourceId: Id }
  | { act: 'stand-down' };

/** Decide the single next click for a pending payMana ask. Pure — the wiring
 *  below owns chain state (strikes, stand-down persistence). */
export function autoManaAction(
  p: Extract<Prompt, { kind: 'payMana' }>,
  state: GameState,
  cantPay: Id[],
): AutoManaDecision {
  const pips = parseRemaining(p.remaining);
  const my = me(state);
  if (pips === undefined || my === undefined) return { act: 'stand-down' };

  const commanderColors = my.commandZone
    .filter(c => c.kind === 'commander')
    .flatMap(c => c.colors) as PoolColor[];
  const sources: SourceInfo[] = [];
  for (const id of p.sources ?? []) {
    if (cantPay.includes(id)) continue;
    const card = findObject(state, id);
    const alts = card !== undefined ? sourceProduction(card, commanderColors) : undefined;
    if (alts !== undefined) {
      const creature = card!.types.some(t => t.toLowerCase() === 'creature');
      sources.push(creature ? { id, alts, creature } : { id, alts });
    }
  }

  const plan = planPayment(pips, my.manaPool, sources);
  const first = plan?.[0];
  if (first === undefined) return { act: 'stand-down' };   // uncoverable, or nothing to pay
  return first.kind === 'pool' ? { act: 'pool', color: first.color } : { act: 'tap', sourceId: first.id };
}

// ── wiring ───────────────────────────────────────────────────────────────────

export interface AutoManaActions {
  answerPrompt(promptId: number, answer: { type: 'mana'; color: PoolColor }): void;
  /** Source clicks go through the probe-recording action so the no-progress
   *  machinery (route's cantPay carry-over) sees the solver's clicks too. */
  clickManaSource(promptId: number, sourceId: Id): void;
}

/** Subscribe the solver to the stores. Chain state lives here: a chain is a
 *  consecutive run of payMana asks; any other prompt (or promptDone) ends it.
 *  One no-progress click re-plans (route's cantPay excludes the source); a
 *  second stands the solver down for the rest of the chain. Toggling auto-mana
 *  on mid-ask re-solves the current ask with a fresh chain — the player asked.
 *  Returns the unsubscribe. */
export function wireAutoManaSolver(stores: Stores, actions: AutoManaActions): () => void {
  let lastPromptId: number | undefined = stores.prompt.getState().pending?.promptId;
  let chain: { strikes: number; stood: boolean; lastRemaining?: string; acted: boolean } | undefined;

  const solve = (): void => {
    const s = stores.prompt.getState();
    const p = s.pending;
    if (p?.kind !== 'payMana') { chain = undefined; return; }
    if (!stores.game.getState().autoMana) return;   // manual flow; chain survives a quick off/on
    const state = stores.game.getState().state;
    if (state === undefined) return;

    chain ??= { strikes: 0, stood: false, acted: false };
    if (chain.acted && chain.lastRemaining === p.remaining) {
      // our click didn't shrink the cost — re-plan once (cantPay now excludes
      // a probed source), then stand down rather than loop
      chain.strikes++;
      if (chain.strikes >= 2) chain.stood = true;
    }
    chain.acted = false;
    if (chain.stood) { stores.prompt.setState({ autoPay: 'stood-down' }); return; }

    const decision = autoManaAction(p, state, s.cantPay);
    if (decision.act === 'stand-down') {
      chain.stood = true;
      stores.prompt.setState({ autoPay: 'stood-down' });
      return;
    }
    chain.acted = true;
    chain.lastRemaining = p.remaining;
    stores.prompt.setState({ autoPay: 'paying' });
    if (decision.act === 'pool') actions.answerPrompt(p.promptId, { type: 'mana', color: decision.color });
    else actions.clickManaSource(p.promptId, decision.sourceId);
  };

  const unsubPrompt = stores.prompt.subscribe(s => {
    const pid = s.pending?.promptId;
    if (pid === lastPromptId) return;   // scratch churn, not a new ask
    lastPromptId = pid;
    solve();
  });

  let lastAuto = stores.game.getState().autoMana;
  const unsubGame = stores.game.subscribe(g => {
    if (g.autoMana === lastAuto) return;
    lastAuto = g.autoMana;
    if (g.autoMana) { chain = undefined; solve(); }              // fresh chance — the player asked
    else if (stores.prompt.getState().autoPay !== undefined) {
      stores.prompt.setState({ autoPay: undefined });            // §6: re-renders manual immediately
    }
  });

  return () => { unsubPrompt(); unsubGame(); };
}
