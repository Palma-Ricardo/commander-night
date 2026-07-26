# Commander Night — Prompts on the Table (removing the dock and modals)

**Date:** 2026-07-25 · **Status:** ACCEPTED — reviewed 2026-07-25 (combat flow reworded to
the five-step attack-target framing; carousel hand mode, generic-cost colorless preference
with overshoot allowed, and rebuild-only threshold constants all decided in review) ·
**Scope:** the table client's next
goal after T6: delete the prompt dock and every modal, and re-express each prompt as dedicated
UI living where its subject is — screen space by default, world space where the subject is a
table object. Also: drag-to-cast, pointer-to-target, and auto-mana that actually pays. Covers
the two additive protocol fields and the bridge derivation they need.

Companion documents:

- `docs/plans/2026-07-21-table-client-design.md` — the table client this extends (T0–T6).
  Its §6.4 (input never waits), §7.1 (two spaces) and §13 milestone conventions all apply.
- `docs/protocol/v1.md` — the wire contract. This phase extends §8 **additively** (two optional
  fields, §7 below); no breaking change. Wire shapes land there first, then code.
- `docs/bridge/design.md` — the daemon; gains one derivation (M7).

## 1. The premise

The prompt dock is one corner-anchored surface multiplexing ten interactions whose meaning
lives somewhere else on screen — on a creature, on the stack, in a graveyard, in your hand.
Every prompt gets teleported to the corner and re-expressed as generic buttons; the player's
eyes bounce between the thing and the controls for the thing. T3 built it deliberately (parity
first, port the classic dock, ship a switchable client); this phase un-builds it.

Two goals, in tension order:

1. **Each prompt renders where its subject is.** Confirmation lives in a fixed corner; a cost
   lives under the spell it pays for; a target pick lives on the pointer; a library look lives
   in a hand-like fan. The dock and `Modal.tsx` are *deleted* at the end, not hidden.
2. **Fewer clicks.** Drag-to-cast merges pick-up and confirm. Pointer-to-target merges
   attacker-toggle and defender-pick. Auto-mana removes every payment click for the common
   case. Single-target picks already auto-submit (§8's one-click rule); this phase extends
   that spirit everywhere.

The classic client is untouched — it keeps its dock and stays at `/classic`.

## 2. Decisions

| Decision | Choice | Basis |
|---|---|---|
| Removal strategy | **Strangler**: each milestone moves whole prompt kinds off the dock; the dock keeps rendering only not-yet-migrated kinds, and is deleted with the last one | The client stays playable (and e2e-green) at every commit; no big-bang cutover |
| Confirmation home | **Corner cluster**, bottom-right: one contextual primary (Yes / Done / OK) + secondary (No / Decline / Cancel) + an always-visible Pass | `{confirm,true}` is the same wire shape for confirm-Yes, combat-Done and incremental-Done — one button can be all of them, labeled by prompt kind |
| Targeting | **Pointer-to-target**: press on the subject, drag, release on the target | Merges two clicks into one gesture; reads like pointing at the table |
| Round-trip-spanning gestures | **Pending-intent buffer** (§4.3): the gesture records what the player meant; wire prompts consume the intent as they arrive | The protocol is one toggle per round trip (§8: combat rejects `{objects}`); the gesture must not know or care how many prompts implement it |
| Off-board cards | **Carousel browser** (§4.4): a hand-like fan, paged, no vertical scroll | Replaces every modal card grid *and* finally gives the table client pile browsing (the `browsable` CardGrid has been dead code since T3) |
| Auto-mana | **A client-side solver answers residual `payMana` asks** (§6); toggle off = today's manual source clicking | XMage's server auto-payment already eats the unambiguous cases; what surfaces is the residue, and most of the residue is still solvable |
| Prompt message | **One `InstructionLine`, top-center under the ribbon**, always showing `p.message` | The dock is currently the only place the message renders, and for several kinds the message *is* the meaning ("Select a nonland card from Miguel's graveyard") |
| Modals generally | **Zero backdrop-modals remain.** Concede becomes a corner pop-panel (same type-to-confirm); fatal becomes a full screen like the takeover screen | "No modals" includes the two non-prompt ones |
| Protocol | Two additive optional fields: `payMana.for?`, `distribute.among[].objectId?` (§7) | Anchoring and click-to-distribute need identity the wire doesn't carry today; everything else is client-only |
| Milestones | Bridge continues **M7**; client continues **T7–T10** | Same series as the table client design §13 |

## 3. What is being replaced

The full inventory (surfaces, inputs, answers) was mapped 2026-07-25; the short form:

- **`PromptDock.tsx`** — all ten §8 prompt kinds render here; four of them
  (`choosePile`, `playerRequest`, `distribute`, `chooseTargets`+`cards[]`) open backdrop
  modals from inside it.
- **`Modal.tsx`** — the backdrop + `CardGrid`; also the dead `browsable` pile path.
- **Concede type-to-confirm** (`TurnControls.tsx`) and the **fatal modal** (`App.tsx`) — the
  two non-prompt modals.

Everything is driven by exactly three inputs: `game.prompt` → prompt store, `game.promptDone`,
and `connection.status === 'fatal'`. Nothing else may light these surfaces, and that stays true.

Explicitly *not* in scope: the over-banner/rematch, reconnect banners, toasts, takeover screen,
ribbon, compass, camstate, mana-pool window, log panel, turn-control dropdowns.

## 4. Interaction primitives

Four building blocks; every prompt kind in §5 is a composition of them.

### 4.1 The corner cluster

Bottom-right, always mounted in-game. Three slots:

- **Pass** — always visible; enabled ⇔ a plain `priority` prompt is pending; sends
  `{confirm,false}`. Its permanent presence *is* the priority indicator (with the §5 highlight
  rings), replacing the dock's "click a highlighted card to act" hint.
- **Primary** — contextual: `confirm` Yes (`yesText`), combat **Done**, incremental-targets
  **Done**, multi-target **Submit k of n** (with the same enabled logic the Enter shortcut
  mirrors), `chooseAmount` **OK**, special (**All attack**, wired to §5's flow).
- **Secondary** — No / Decline / Cancel, shown only when the pending prompt is declinable
  (exactly `resolveShortcut`'s Escape predicate — the two must stay one function).

The cluster reads only `prompt.pending`/`inflight`/`selected` — the same fence and promptId
capture the dock has today. `inflight` disables the cluster and shows the spinner.

### 4.2 Pointer-to-target

Press on a subject, drag a chalk line (the T4 attack-arrow vocabulary), release on a target.
Release on nothing = no-op (the line evaporates); the press alone still performs the
subject-click the affordance model prescribes, so click-without-drag keeps today's behavior.
All hit-testing goes through the existing `affordanceFor` + `objectClick` path — the gesture
is a *composition* of affordance clicks, never a new answer channel.

### 4.3 The pending-intent buffer

Some gestures span round trips. Declaring an attacker is `{object}`; *whom it attacks* arrives
as a separate follow-up `chooseTargets` (worded "Select defender" by XMage — see §5.1's
terminology guard; protocol §8) — always in multiplayer, but skipped when the board has a
single possible defender. The gesture must not block on that.

A small store slot: `intent?: { objectId: Id; expiresOnPromptId: number }`. The drag's release
records the intended target; when the next prompt arrives, if it is a `chooseTargets` whose
candidates include the intended id, the client answers it immediately; otherwise the intent is
dropped (it *expires on the first prompt that doesn't match* — never held across two prompts,
so a stale intent can never answer the wrong question). This is the same fencing philosophy as
promptId capture, applied one prompt into the future.

### 4.4 The carousel browser

A hand-like fan of card fronts in screen space, center-bottom, above the hand: pages of ~8-10
with left/right paging (wheel, arrow keys, edge buttons), never vertical scroll. Selection
state renders on the cards; **confirm/decline live in the corner cluster** — front and center,
not buried under a grid. Two clients:

- **Prompt mode** — `chooseTargets`+`cards[]`, and any candidate set the felt can't offer
  (§8.2 below). Server candidate order is preserved (reordering a choice list would be lying —
  Modal.tsx's rule, kept).
- **Browse mode** — clicking own graveyard/exile (and revealed piles) opens the same fan
  read-only, with the scan ordering + name filter from `pile.ts`. This retires the dead
  `browsable` CardGrid path *and* closes the "table client has no pile browser" gap.
- **Hand mode** (decided 2026-07-25) — an oversized hand renders through the same paged fan
  instead of compressing: once the fan overlap would drop below readability (threshold a
  tunable beside the cast threshold, start ~10 cards), the hand pages rather than crams.
  Drag-to-cast (§9) must work identically from a paged hand — the press-lift-release gesture
  is per-card and doesn't care how the card was framed.

## 5. Per-prompt surfaces

| Kind | Surface | Clicks saved vs dock |
|---|---|---|
| `confirm` | InstructionLine + corner Yes/No | — |
| `priority` | Highlight rings (already canvas) + corner Pass; hint text deleted | — |
| `priority`+`combat` | §5.1 pointer flow + corner Done / All attack | toggle+defender merge into one gesture |
| `chooseTargets` (felt candidates) | §5.2 pointer flow; corner Submit/Done/Decline for multi-pick | — |
| `chooseTargets` (`cards[]` / unreachable) | Carousel prompt mode + corner controls | — |
| `payMana` | §5.3 anchored cost panel; or **no UI at all** (auto-mana, §6) | all of them, usually |
| `chooseAbility` | §5.4 option list anchored to the acted-on card | — |
| `chooseOption` | §5.4 screen-space tiles | — |
| `choosePile` | Two card fans side by side in screen space, InstructionLine above, a pick button per fan | — |
| `chooseAmount` | Screen-space stepper + free input, anchored like payMana when an anchor exists (X announcement), else center; corner OK | — |
| `distribute` | §5.5 click-to-increment on permanents + running counter chips | typing → clicking |
| `playerRequest` | Corner pop-panel (title + option buttons) — rare meta dialog (rollback permission), stays plain | — |
| Concede | Corner pop-panel, same type-to-confirm, no backdrop | — |
| Fatal | Full screen (takeover-screen treatment) | — |

### 5.1 Combat: point at what you're attacking

Terminology guard: XMage's follow-up ask for an attacker is worded **"Select defender"**,
where *defender* means the player/planeswalker being attacked — nothing to do with blockers.
This doc says **attack target** for it throughout. The gesture flow, per combat step:

1. **Begin combat** — nothing new; the phase ribbon and T4 choreography already mark it.
2. **Declare attackers** (active player): press a candidate creature → the toggle-in
   `{object}` sends immediately (the wire is one toggle per round trip) → keep holding; the
   chalk line follows the pointer → release on the intended attack target (a nameplate,
   quadrant, or planeswalker/battle when the candidate list offers one) records the intent
   (§4.3). XMage's follow-up chooseTargets for *whom that creature attacks* — always sent in
   a multiplayer game, since the board has multiple defenders — is answered from the intent
   on arrival. This is exactly today's dock two-step (toggle click, then target click),
   merged into one drag. Release-without-drag just toggles, and if no follow-up comes the
   intent expires harmlessly. Toggling out = click a `declared` creature, as today.
3. **Declare blockers** (each defending player): symmetric — press a candidate blocker,
   drag, release on the attacking creature to block it; the follow-up which-attacker pick is
   consumed from the intent. Same two-step, same merge.
4. **Combat damage** — no interaction; T4's three-lane layout and damage lunges already
   present it.
5. **Second main** — the step change arrives as state like any other; nothing prompt-side.

**All attack** stays in the corner: `{option,'special'}` declares everyone, then the
attack-target prompts arrive as a queue — each one highlights the creature it's asking for,
and the player answers each with a single point-and-release (no press-on-subject needed; the
subject is given). Done = corner primary, `{confirm,true}`.

### 5.2 chooseTargets: one kind, three bodies

The wire kind is XMage's generic "pick objects" and does at least triple duty; the client
dispatches on where the candidates live:

- **Felt/players** (real targeting, ability targets, equal-split distribution): pointer flow.
  When a spell/ability on the stack is the source, the press subject is the stack card; for
  bare picks ("sacrifice a creature") a plain click on a candidate is the whole gesture.
- **Own hand** (discard picks): click cards in the hand fan; selection accumulates in
  `selected`; corner Submit.
- **`cards[]` or unreachable candidates**: carousel prompt mode. **No-dead-end invariant
  (table design §13, live-caught twice):** any candidate the felt cannot offer as a click —
  pile-zone ids, ids outside this seat's view — *must* appear in the carousel, which opens
  automatically when such candidates exist. `unreachableCandidates` survives as the detector;
  the stranded-target dock buttons are replaced by real card views in the fan.

Single-target (`max === 1`) keeps one-click/one-release auto-submit. Incremental progress
(`progress.chosen`) renders on the InstructionLine; incremental Done is the corner primary.

### 5.3 payMana: the cost lives under the spell

An anchored panel below the paying object's card (world-anchored via the same
`sceneToScreen` machinery hover previews use): the remaining cost in mana symbols, pool-spend
pips (click = `{mana,color}`), Cancel. Sources stay highlighted on the felt as today; the
no-progress badge (`cantPay`/`manaProbe`) keeps working — the mechanism is prompt-store-side
and doesn't move.

**Anchor resolution:** protocol `for` id (§7.1) when present → that object's actor (stack or
battlefield); absent (older bridge) → top of stack if any, else the panel docks beside the
corner cluster. The client must render sanely with no anchor forever — the field is optional.

### 5.4 chooseAbility / chooseOption

`chooseAbility` is N ability options *of one source*. The wire `sourceId` is in practice never
set (bridge `PromptTranslator`: "No source id exists on the view"), but the client knows what
the player just clicked — `actedOn` in the prompt store. Anchor the option list to that actor;
fall back to screen-center. One card copy + a vertical option list, exactly one click.

`chooseOption` is `GAME_CHOOSE_CHOICE`: pick one *string* — sometimes modes, but also colors,
creature types, numbers-as-choices, often with **no card at all**. Rendering: large
screen-space tiles (option text, mana/color symbols rendered via `ManaText`); when the option
list is mode-text of the resolving object, the `actedOn`/stack-top card renders beside the
tiles for context. Card-per-option is explicitly *not* the general design — the options are
strings.

### 5.5 distribute: click the recipients

`GAME_GET_MULTI_AMOUNT` — damage/counter division for the fewer-points-than-targets case
(equal splits ride chooseTargets and never reach this kind). New surface: each row's permanent
carries a counter chip; clicking a permanent increments its row (wrapping to `min` past its
`max`); right-click/long-press decrements; a screen-space tally shows Σ against
`min ≤ Σ ≤ total`; corner Submit sends `{distribution}` whole, corner Cancel when
`canCancel`. Needs `among[].objectId` (§7.2) to know which permanent is which row; until the
bridge provides it — and for rows that resolve to no object (players, face-down) — the rows
render as labeled screen-space chips with the same click-to-increment, which is still
click-not-type. Caveat honestly carried from §8: this kind has **never been observed live**;
the surface ships behind fixtures until it fires at a real table.

### 5.6 The engine says no: rescind and illegal-move toasts

Motivating incident (live pass, 2026-07-25): Entrancing Melody at X=5 silently self-canceled
four times. The tap autopsy showed the rules engine was *right* — the only MV-5 creature
(Zurgo Helmsmasher) wore Lightning Greaves, and shroud left the adjusted target filter with
zero candidates — but XMage 1.4.60 rescinds such a cast with **no feedback of any kind**: the
announce log line is only emitted after the whole cast succeeds, so the player sees the ask
accept their X and then... nothing. Four attempts, no clue. Two mechanisms fix this class,
both T8:

- **(a) Promote `kind:'personal'` log lines to toasts.** For illegal moves it can see coming,
  XMage *does* explain itself — `game.informPlayer` fires on illegal block/attack declarations
  and kin ("Zurgo Helmsmasher can't block this way.") — and the pipe already exists end to
  end: `GAME_INFORM_PERSONAL` → `game.log kind:'personal'` (protocol §15) → a 🕵-marked line
  in the LogPanel that nobody reads mid-combat. T8 additionally renders every personal line as
  a toast; by construction these are rules feedback addressed to this seat alone, and the
  engine's own text names the source better than anything we could synthesize. The log copy
  stays.
- **(b) Detect the silent cast rescind client-side.** No wire signal exists for the
  Melody case, but its signature is clean and the client sees all of it: our own cast put the
  card on the stack, a cast-flow prompt ran (`chooseAmount` announce / `chooseTargets` /
  `payMana`), and the next state shows plain `priority` with the stack object gone and the
  card back in hand — neither resolved nor countered. Toast: "the cast was rescinded — no
  legal target." Only fires when the prompt chain began from this seat's own cast (the
  prompt-store `actedOn` context knows), never for prompts that vanish because someone else
  acted. **Name the source when confident:** the board state already carries each permanent's
  attachments (T4 renders them riding under their host) and Scryfall oracle text is loaded for
  rendering — when the scan finds untargetability grantors (shroud/hexproof/protection) on
  otherwise-plausible candidates, append the culprit: "(Zurgo Helmsmasher has shroud from
  Lightning Greaves)". Emit-only-when-confident, same rule as the M-series scrapes — a
  generic toast is better than a wrong accusation.
- **(c) The empty ask** (live-found T8, game 4CFQPJ — added same day). Mechanism (a)'s premise
  fails for blocks: XMage does *not* let an illegal block reach `informPlayer` — it pre-filters
  the candidates, so "Select attacker to block" against Tasigur wearing Sword of Feast and
  Famine arrives with **zero candidates** and no personal message ever fires. Clicking the
  protected attacker is a silent no-op on an ask with no legal answer; the only escape was the
  cluster's unexplained Decline. The empty candidate list *is* the signal: a `chooseTargets`
  arriving with zero candidates toasts the story client-side — `blockCulprit` scans the
  declared attackers for a blocking restriction (protection/menace/can't-be-blocked, the
  grantor named in parentheses when an attachment carries the clause) under the same
  exactly-one-story rule, with a generic quote-the-ask fallback for non-combat empties.

## 6. Auto-mana that is actually auto-mana

Today the toggle is XMage's server-side `MANA_AUTO_PAYMENT_ON/OFF`, which pays only when the
choice is unambiguous — everything else surfaces as `payMana`. New semantics:

- **On** (default): the server toggle stays on *and* the client solver answers the residual
  `payMana` asks. The player sees the §5.3 panel flash the cost being paid (a beat, not a
  wait) and their lands tap themselves — the §9 juice already animates the taps.
- **Off**: today's manual flow, unchanged (§5.3 panel + source clicks).

**The solver.** Inputs: `remaining` (parsed pips), the pool, `sources` joined against visible
state for each source's producible colors. Floating pool spends first (`{mana,color}` — it is
otherwise lost). Then a small backtracking exact-cover over sources×pips (cost pips ≤ ~10,
sources ≤ ~20 — trivial search space). Preference rules: **colored pips** draw from the
source with the smallest production set that covers them (basics before duals, so flexible
sources stay untapped); **generic pips** draw from colorless-only sources first, then the
least-flexible remainder — a `{2}{B}{W}` cost taps Sol Ring + Swamp + Plains, never four
lands whose colors a cost might need. Above both rules, **creatures are last-resort sources**
(added at T10 from the first live run, tap RFZB6J): Rishkar grants every countered creature
"{T}: Add {G}", XMage renders the granted line into the creature's own rules text, and a
production-set ranking alone tapped the whole team out of combat every turn — a creature
only taps when no other source covers. **Overshoot is allowed** (decided 2026-07-25): a
multi-mana source may be tapped even when its production exceeds what remains — the
remainder floats, and since floating pool spends first (the opening rule above), the excess
is fuel for the next spell, not waste. Minimizing overshoot is a tie-break only, never a
constraint. Accepted consequence: leftover floating mana will eventually surface XMage's
"mana will be lost. Pass anyway?" confirm — that renders on the corner cluster like any
`confirm` and is the player's call; the solver never answers it. One
`clickManaSource` per re-ask, strictly sequential — each re-ask mints a fresh promptId and the
solver re-plans from the new `remaining` (it never scripts N clicks ahead), which also makes
it naturally correct when XMage's own auto-payment eats part of the cost mid-stream.

**It stands down** — leaving the manual panel up, solver paused for this ask — when: any pip
is not plainly coverable (Phyrexian `{B/P}` where mana can't cover it, snow, sacrifice-cost
sources, a source whose production it can't read); a clicked source fails to shrink
`remaining` (the existing no-progress probe — the source goes to `cantPay` and the solver
re-plans *once*, then stands down rather than loop); or the plan can't cover `remaining` at
all. Cancel is never sent by the solver. The bridge's 150 ms pacing (`XmageAnswers`) is
upstream of all of this — the solver can fire as fast as prompts arrive.

Choice-quality risk is accepted and bounded: the residue is by definition ambiguous, the
solver's preference order is a heuristic, and the escape hatch is the toggle — which is
per-seat UI state, flippable mid-payment (the current ask re-renders manual immediately).

## 7. Protocol additions (v1, additive)

Wire changes land in `docs/protocol/v1.md` §8 first, per convention. Both fields optional;
clients ignoring them (the classic client) are unaffected; the table client renders sanely
when they're absent.

### 7.1 `payMana.for`

```ts
| { kind:'payMana'; remaining: string; sources?: Id[]; canCancel: boolean;
    for?: Id }   // NEW — the object whose cost is being paid (the card being cast, or the
                 // permanent whose ability is activating); anchoring hint only, never load-bearing
```

The `GAME_PLAY_MANA` callback itself carries no source *field* (`HumanPlayer.playManaHandling`
fires the event with an empty options map). Candidate derivations were (a) the newest stack
object whose controller is this seat, and (b) FSM-side tracking of the `{object}` answer that
opened the payment chain.

**Spike result, 2026-07-25 — neither; a third derivation won.** Replayed all 20 callback-tap
captures offline (`bridge/.../golden/PayManaAnchorReplayTest`, `mvn test
-Dsurefire.excludedGroups= -Dtest=PayManaAnchorReplayTest`): **1114 `GAME_PLAY_MANA` asks**.

- The ask's own *message* names the paying object. `ManaCostsImpl.pay` builds its prompt text
  through `ManaUtil.addSpecialManaPayAbilities`, which appends
  `baseObject.getLogName()` — and `GameLog.getColoredObjectIdName` writes the object's **full
  UUID** into an `object_id='…'` attribute (the Swing client's card-popup hook). Present on
  **1114/1114** asks; **never twice** in one ask; the linked id was, in every case, an id this
  seat had already seen as a real card actor (hand 771, command zone 333, battlefield 10).
  Nothing to infer — the ask carries the answer.
- (a) is *sound but points at the wrong id*. The stack was non-empty on all 1114 asks and its
  top was still unpaid on 1104 (`CardView.paid`, which `GameView` fills from
  `getManaCostsToPay().isPaid()`), confirming the spell/ability really is pushed before costs
  are paid. But a spell's stack key is `spell.getId()` (the ability id), **not** the card id —
  and the table client canonicalizes a cast's stack actor onto the stable card id
  (`scene/keys.ts` stackLink adoption), so the stack id is not an actor key at all. It matched
  the message link 0/1114 times. The other 10 asks are the case (a) gets *semantically* wrong:
  an opponent's "unless you pay {2}" trigger (Mogis) sits on top, fully paid, while the object
  the cost belongs to is the one the message names.
- (b) was not needed, and would have been worse: the `{object}` answer that starts a cast is
  the *hand card* id, which the message link already gives, and it requires new FSM state
  that would have to survive re-asks.

Implemented as: emit `for` iff the raw message carries exactly one `object_id` link
(`translate/ObjectLink`); canary WARN when the message renders an object name (`<font …`) but
no pinned link parses — an upgrade moving `GameLog`'s attribute degrades the field to absent,
never to wrong. Emit-only-when-confident holds: absent beats wrong (a cost panel under the
wrong card actively misleads).

### 7.2 `distribute.among[].objectId`

```ts
among: { id: Id; label: string; min?: number; max?: number; suggested?: number;
         objectId?: Id }   // NEW — the game object this row divides onto, when resolvable
```

`MultiAmountMessage` rows are positional text. **Implemented 2026-07-25** with the same
`object_id` link the payMana spike found: 1.4.60 builds the object-bearing rows as
`String.format("%s, P/T: %d/%d", permanent.getLogName(), power, toughness)`
(`CombatGroup.assignDamageToBlockers`/`ToAttackers`, and the handful of cards that divide
damage themselves), so the row label carries the permanent's UUID exactly. Rows without a
link fall back to a **unique** name match against the visible battlefield; ambiguous matches
(two Grizzly Bears), rows that name no object (mana letters `R`/`G`, counter names) and
player rows (`PlayerImpl.getLogName` is `getColoredPlayerName` — no id attribute) omit the
field and render as chips (§5.5). Best-effort by design, same as the commander-damage scrape:
pinned to 1.4.60 strings, canary WARN when a row matches the pinned `", P/T: p/t"` shape yet
resolves to nothing. Answers stay keyed by the row `id`; `objectId` is never load-bearing.

## 8. Invariants that survive the redesign

- **One prompt, one fence.** Everything still reads `prompt.pending`/`inflight`/`selected`;
  every submitter captures the promptId it rendered with; the intent buffer (§4.3) extends
  the fence one prompt forward, never weakens it.
- **Input never waits** (table design §6.4). New surfaces mount on `game.prompt` arrival,
  independent of the director's presented state; the §14 pull-back policy (all prompt objects
  visible before actionable) applies to pointer-flow subjects identically.
- **The message always renders** — the InstructionLine is unconditional, every kind.
- **No dead ends** (table design §13). The carousel auto-opens for unreachable candidates;
  the e2e no-dead-end poll extends to count carousel cards and corner controls as answers.
- **Keyboard parity.** `resolveShortcut` is untouched wire-wise; Space/Enter/Esc/A/F4/F6 keep
  answering. The corner cluster and the shortcuts must share one enabled-predicate module so
  they can never disagree (today the Enter path *mirrors* the dock button by convention —
  make it structural). The `.modal-suspends-shortcuts` DOM guard dies with the modals; the
  concede pop-panel and carousel filter suspend shortcuts by focus (`isTextInput`) alone.
- **The harness stays semantic.** `answer`/`pass`/`click` go through core actions, not DOM —
  the T5 driver is unaffected by deleting the dock. `highlights()` grows carousel/corner
  visibility so specs can assert the no-dead-end invariant against the new surfaces.

## 9. Drag-to-cast

Press a hand card → it lifts and follows the pointer (screen-space ghost; the hand fan closes
the gap); release above the **cast threshold** → the same `{object}` answer as click-to-cast;
release below → the card slides home, no-op. Threshold: fraction of viewport height measured
from the bottom, default **0.33**, a named constant in one constants module (Ricardo expects to
tune toward 0.25 by feel; a rebuild per adjustment is fine — no settings exposure yet,
decided 2026-07-25). Click-without-drag keeps working unchanged. Multi-action cards still get the
server's follow-up `chooseAbility`, which now renders anchored to the card (§5.4) — the drag
flows directly into the choice. Mana-only cards (`manaOnly` affordance) neither lift nor cast,
as today.

## 10. Milestones

Bridge M7 is independent of T7–T9 and can land any time before T10.

| # | Deliverable | Exit criterion |
|---|---|---|
| T7 | Corner cluster + InstructionLine + drag-to-cast. `confirm`, plain `priority`, `chooseAmount` off the dock; concede → pop-panel; fatal → screen; threshold tunable live | Full game vs 3 AIs playable with those kinds never rendering in the dock; auto-player spec green (it answers semantically, so this is a rendering-only assertion + a human pass). **Engineering done 2026-07-25:** `promptControls` extracted to `@night/core/state/prompt-controls` and `resolveShortcut` refactored onto it (behavior-neutral — the untouched shortcuts tests pin it; core 244); CornerCluster (Pass always visible + contextual primary/secondary/special) + InstructionLine + screen-center AmountSelector; **combat's Done/All-attack buttons also migrated** (button-for-button identical, the module already owned them — canvas toggles unchanged, gesture is T8); dock strangled to the 7 remaining kinds, message line removed; concede → outside-click pop-panel (no Escape handling, so it can never race the prompt shortcuts); fatal → full screen; drag-to-cast in TableScene (pointer pin after tweens, slop 6 px, swallow-the-Pixi-tap guard, window-level release, always slide home — a successful cast retargets the tween mid-flight per §6.3) with `table/src/tuning.ts` constants. e2e driver: prompt surface = dock *or* cluster, `.dock-busy` anywhere, cluster/amount buttons count toward no-dead-end. Verified: core 244 · classic 30 · table 126, both prod bundles grep-checked, two-browser smoke 12.9 s, **auto-player green — full game to `game.over`, 2.0 min, combat declared, 0 resyncs**. Remaining: Ricardo's live feel pass (drag threshold, cluster placement). |
| T8 | Pointer-to-target + intent buffer: combat (attackers/blockers/all-attack) and felt/hand `chooseTargets` off the dock. **Engine-says-no toasts (§5.6):** `kind:'personal'` log lines promoted to toasts; silent cast-rescind detection with best-effort source naming | A 4-player combat declared entirely by drag gestures incl. an attack whose attack-target prompt is consumed from intent, and a block declared by drag on the defending seat; e2e combat coverage stays green; no-dead-end poll extended. An illegal block attempt toasts the engine's explanation; the 2026-07-25 Melody rescind (tap B2XF4W), replayed as a fixture, toasts the rescind and names Lightning Greaves. **Engineering done 2026-07-25:** core `state/intent.ts` — `pointTarget` (answers a pending single-pick, toggles a multi-pick, else buffers `intent`) + `wireIntentBuffer` (consume-or-drop on the *first* new prompt, strict single-pick match, survives `promptDone` — the failure mode is not-answering, never wrong-answering); core `state/rescind.ts` — `wireRescindDetector` arms on a cast-flow ask with our own spell on the stack top and decides once at the next plain priority (stack object gone + card back in hand + last answer ≠ Cancel ⇒ toast), `culprit()` names the source only when the board holds exactly one shroud/hexproof/protection story; `route` promotes `kind:'personal'` lines to toasts (fenced on `appended`). Table: two-mode drag — 'cast' pins the card, 'point' chalks a tether and the subject stays put; combat candidates toggle on the press (one toggle per round trip) and the hold becomes the pointer; stack-top source drag for chooseTargets (guarded when the top is itself a candidate); drop resolves candidate actor → nameplate → any actor → quadrant; nameplates are click/drop targets for player candidates with the target-ring stroke; `dockOwns` (`chrome/migration.ts`) is the single strangler predicate shared by dock + cluster — board-reachable chooseTargets leave the dock, cards[] grids and pile-zone bodies stay for T9; InstructionLine gains "n confirmed"; `highlights()` includes player candidates so the no-dead-end poll counts them. The B2XF4W fixture replays through `route()` in `rescind.test.ts` and names the Greaves. Verified: core 265 · classic 30 · table 132, bundle grep-checked; e2e vs the table client all green — two-browser 12 s, resilience 9.3 m, auto-player 5.4 m with combat declared. (Three earlier auto-player runs failed from host CPU starvation — a competing game pegged the cores and XMage's lease pings flapped every 20 s; on a quiet machine the spec passed first try.) Live pass 2026-07-25: drag-declared combat confirmed working; it surfaced the All Attack gap — the server-side declare sends the same "Select defender" follow-ups with no drag in flight, and the point-source rule only armed on the stack top, so dragging attacker → defender did nothing. Fixed same day: any non-candidate **world** actor arms the point drag during a target ask (subsumes the stack-top rule; legality still lives with pointTarget). The illegal-block criterion was **wrong about the engine**, tap-verified same day (game 4CFQPJ, Tasigur + Sword of Feast and Famine): XMage pre-filters illegal blocks out of the candidates — "Select attacker to block" arrives with *zero* candidates and no `GAME_INFORM_PERSONAL` ever fires, so there is no engine line to toast. Rescoped to §5.6c and shipped: an empty-candidates chooseTargets toasts the story client-side — `blockCulprit` names the one blocking restriction among the declared attackers, grantor in parentheses ("Tasigur, the Golden Fang has protection from black and from green (Sword of Feast and Famine)"), generic quote-the-ask fallback, same emit-only-when-confident rule. The personal→toast promotion stays for whatever XMage does validate late. |
| T9 | Carousel browser (prompt + browse modes) + remaining screen-space surfaces: `cards[]` chooseTargets, `choosePile`, `chooseAbility`, `chooseOption`, `distribute` (chip fallback), `playerRequest`. **`PromptDock.tsx` and `Modal.tsx` deleted** | Every §8 kind renders dock-free (fixture-driven for the never-seen-live kinds); graveyard/exile browsable at last; both e2e specs green on the table client; classic client byte-unaffected. **Engineering done 2026-07-25:** the carousel is *canvas*, not DOM — it is also the hand rendering for oversized hands (§4.4 hand mode), and drag-to-cast is a canvas gesture, so one fan implementation serves all three modes. `layout/carousel.ts` (pure): `carouselContent` (prompt mode = `cards[]` else unreachable candidates, players excluded since their nameplates ring; browse mode = any seat's graveyard/exile through pile.ts scan order + name filter; **prompt mode wins over an open browse**, which reappears when the ask clears) + `layoutCarouselFan` (pages of CAROUSEL_PAGE_SIZE=9, clamped, centred above the hand band, log-inset aware). `scene/carousel-store.ts`: browse ref / filter / pages keyed by content identity — a new promptId or pile always opens at page 0. TableScene `syncCarousel`: its own actor map (the director's diff never touches it), screen-space CardActors with the same affordance rings + objectClick routing as their board twins (bridge `PromptTranslator` folds `cards[]` ids into `candidates`, so `affordanceFor` just works), card-less entries render the label on a text-frame stand-in, rise-in from below the table edge, wheel + ArrowLeft/Right + edge buttons page, Esc closes browse (before the decline/camera Esc chain). Pile-open: tap the pile's top card (affordance-first — a candidate keeps its prompt meaning) or its bare footprint (handleFeltTap, so an *empty* pile browses too); toggleBrowse closes on re-click. Hand mode: `layoutHand` pages past HAND_PAGE_THRESHOLD=10 (HAND_PAGE_SIZE=8) — off-page cards tuck just below the bottom edge on their page's side, so page turns are ordinary actor tweens and drag-to-cast is structurally untouched; `HandPager` chrome. DOM surfaces: chooseAbility → option list anchored to the `actedOn` actor's live bounds (re-read on a 200 ms interval — the source may still be easing under the §6.4 flush; centre fallback); chooseOption → centred tiles + the actedOn context card when it resolves (open question 4 → yes); choosePile → two CardView fans + a pick button per fan, no backdrop; distribute → chip panel (click +1 / right-click −1, wrapping past the row bounds; `distribute-store` draft, cluster Submit — the amount-store pattern) — still never observed live, fixture-driven; playerRequest → corner pop-panel; payMana → corner-docked panel (cost symbols + pool pips; Cancel was already cluster-side) with T10 owning the `for` anchor. Deleted: PromptDock.tsx, Modal.tsx, migration.ts (`dockOwns` — the cluster now renders for every kind), the `.modal-suspends-shortcuts` guard (focus is the only shortcut suspension, §8 as designed), the dead `browsable` CardGrid path; pile.ts moved to layout/. e2e driver: the new panels' buttons count toward no-dead-end; carousel cards count through `highlights()` (the scene reports carousel actors too). Verified: core 271 · classic 30 · table 147 (carousel content/fan/store/hand-paging suites), both prod bundles built + grep-checked; e2e vs the table client all green on a fresh stack — two-browser 10.7 s, auto-player 2.5 m with combat and 0 resyncs, resilience 9.4 m (reloads on both seats, bumped seat, recovery join, rematch, two game.overs). Classic client and @night/core untouched (byte-unaffected by construction). **Live pass 2026-07-25: everything looks good — T9 closed.** |
| M7 | Protocol §7 fields in v1.md + bridge derivation: `payMana.for` (spike → implement), `distribute.among[].objectId` (name-match, canary on drift); conformance samples + golden fixtures updated | Fields present and correct on live captures where derivable; absent (never wrong) elsewhere; classic client provably unaffected (corpus additive) |
| T10 | Anchored payMana panel (`for` + fallbacks) + the auto-mana solver (§6) | A full game with auto-mana on where no `payMana` ask requires a human click except deliberate stand-downs; toggling off mid-payment re-renders manual on the current ask; solver never sends Cancel and never loops a no-progress source. **Engineering done 2026-07-25:** core `state/automana.ts` — `parseRemaining` (hybrid pips by either half, Phyrexian by the colored half — the solver pays mana, never life; snow/`{X}`/mono-hybrids stand down), `sourceProduction` (basic land types from subtypes; bare `{T}: Add …` lines with " or " alternatives; any-color = WUBRG; the commander-identity wording planned on commander *colors*, always within identity; conditional and sacrifice-cost lines skipped — a source with nothing readable is excluded, and if the rest can't cover, that's the stand-down), `planPayment` (small backtracking cover, pool-spends-first, the §6 preference rules, overshoot minimized as tie-break only) and `wireAutoManaSolver` (chain = consecutive payMana asks; a no-progress click re-plans once via the existing cantPay carry-over, a second stands down for the chain; toggle-on mid-ask re-solves the current ask, toggle-off clears `autoPay` so the panel re-renders manual immediately; Cancel is unreachable by construction — the action surface handed to the wire has no cancel channel). Solver source clicks go through `clickManaSource`, so the manaProbe/no-progress machinery sees them like human clicks. Prompt store gains `autoPay: 'paying'\|'stood-down'`; PayPanel anchors under the paying card via `for` → stack-top → corner chain (`useLiveAnchor` extracted from AbilityOptions, takes a candidate list) and renders the solver state. One preference rule added over §6, learned at the table: **creatures are last-resort sources** — the first live run tapped Rishkar-granted dorks out of combat every turn (§6, tap RFZB6J). Verified: core 298 · classic 30 · table 147, both prod bundles grep-checked; e2e vs the table client with the solver live on every seat: two-browser 12.5 s, auto-player 5.4 m to `game.over` (combat declared, 0 resyncs; the payMana chains in the tap shrink one pip per click to completion), resilience 7.1 m (0 resyncs). Two earlier auto-player runs failed the ≥1-combat assertion — tap autopsies told two stories: the RFZB6J run was the real creature-tapping bug above; the DUZCED run was a one-creature opening hand plus an early death, pure draw variance. One resilience run hit a single missed-patch resync (seq gap, recovered by design, bridge log clean, not reproduced on rerun) — worth a bridge-side look if it recurs. **Live pass 2026-07-25: auto-mana feels nice, the anchored panel sat in the right spot, and a stand-down resumed cleanly after the player's fixing choice (the interleaved ask ends the chain, so the next payMana starts fresh — by construction). T10 closed.** |

Final state: zero backdrop modals in `table/src`, `PromptDock.tsx` gone, both e2e specs green
against the table client, classic client unregressed.

## 11. Risks

- **`distribute` has never fired live.** Its new surface is built on fixtures twice over
  (spec-derived kind, name-match protocol field). Mitigation: chip fallback is the guaranteed
  path; the objectId enrichment is advisory, like all M-series scrapes.
- **The intent buffer answers something unexpected.** Bounded by construction: an intent
  expires on the first non-matching prompt and only ever answers a `chooseTargets` containing
  its exact id. The failure mode left is *not* answering (intent dropped) — which degrades to
  a visible prompt, never a wrong answer.
- **The auto-mana solver taps the wrong thing.** Accepted (§6): residual asks are ambiguous by
  definition; preference heuristic + instant manual toggle bound the damage. Never cancels,
  never loops.
- **payMana anchor is wrong more often than absent.** The M7 spike gates the field; the rule
  is emit-only-when-confident, and the client treats it as a hint. If (a) and (b) both prove
  unreliable the field ships never-set and §5.3's fallback chain is the design.
- **Gesture/camera interaction.** A drag across a camera tween re-projects mid-gesture; the
  chalk line must track screen-space pointer against re-projected world anchors (the hover
  system already solves this per-frame — reuse it). Felt-tap camera focus must not fire on a
  release that ends a drag.
- **Shortcut/UI divergence.** The corner cluster and `resolveShortcut` must share the
  enabled-predicate module (§8), or Enter and the primary button drift apart — today's
  mirror-by-convention has already needed a comment begging it to stay in sync.

## 12. Open questions

1. Does the `GameView` accompanying `PLAY_MANA` reliably show the paying spell on the stack
   (spike 7.1a), and can the FSM's last-acted-on tracking cover ability costs (7.1b)?
2. Solver preference order beyond the two locked rules (smallest-production-set for colored
   pips; colorless-first for generic pips, decided 2026-07-25) — remaining ties are worth
   tuning at the table, not in the doc.
3. ~~Should the carousel also replace the *hand* rendering for oversized hands?~~ **Resolved
   2026-07-25: yes** — carousel hand mode (§4.4), oversized hands page instead of cramming.
4. ~~`chooseOption` tiles: is `actedOn` context-card display worth it, or noise?~~ **Resolved
   at T9 (2026-07-25): yes, when it resolves** — a small non-interactive CardView renders
   beside the tiles iff `actedOn` maps to a card in this seat's visible state; card-less
   choices (colors, numbers) show tiles alone. Cheap, and mode text without its source was
   the noise. Review at the table.
