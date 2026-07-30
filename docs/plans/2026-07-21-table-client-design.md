# Commander Night — Table Client Design (Arena-like)

**Date:** 2026-07-21 · **Status:** ACCEPTED — layout reviewed and chosen 2026-07-21 (§7); M6
(bridge event derivation) done 2026-07-22; T0 (extraction + table scaffold) done 2026-07-22;
T1 (quadrant world + camera rig + screen-space hand) done 2026-07-22; T2 (director + two
clocks + move animations + camera through the director) done 2026-07-22; **T3 (interaction
parity — the client is fully interactive: home→lobby→game, all prompt kinds, canvas
hit-testing/affordances/hover, keyboard, chat/log) done 2026-07-23** — the exit criterion (a
human plays a full game vs 3 AIs to `game.over`) was met on a local stack, closing the
switchable gate; T4 (juice) done 2026-07-24 after three live-review passes (the §9 catalogue,
three-lane combat, damage lunges); **T5 (resilience parity — the browser tier moved to a root
`e2e/` workspace that drives either client, and the auto-player became semantic) 2026-07-24**
· **Scope:**
the second web client — a
canvas-rendered, fully animated four-player table, built alongside the existing React client
(which stays as the working fallback). Covers the protocol extension it needs, the bridge work
that feeds it, and the client architecture itself.

Companion documents:

- `docs/protocol/v1.md` — the wire contract. This phase **extends it additively** (§4); no
  breaking change, no major bump.
- `docs/bridge/design.md` — the daemon. This phase adds one stage to its translation pipeline (§5).
- `docs/client/design.md` — the *classic* client. Stays live and supported; the shared layer
  underneath it is extracted, not rewritten (§11).

## 1. The premise, corrected

The obvious reading of this phase is "throw away the client and rebuild it in something with
animation". That is wrong twice over, and the second correction is the one that matters.

**First:** roughly half of `client/src` — protocol, net, stores, state, image resolution — is
view-independent, and it is the half that was expensive. It carries the socket FSM, resume and
idempotency, the patch/resync gate, and the prompt fence, and it cost C0–C4 plus three bugs found
the hard way (silent seat-identity loss, dead-end `chooseTargets`, the post-game chat gap). None of
that is visual. It gets **extracted and shared**, not rewritten. That alone rules out Godot and
native desktop, which would re-earn all of it in a new language for zero visual gain — on top of
Godot's ~40 MB wasm payload, WebGL2-only export, and weakness at exactly the text-heavy UI (oracle
text, log, chat, prompts) that this client is full of.

**Second, and this reshapes the whole phase:** the reason v1 deferred animation was a factual
error. `docs/protocol/v1.md:352-357` justifies shipping "teleport" rendering with

> Deriving *"card X moved hand → battlefield"* events from XMage snapshots is heuristic (XMage
> assigns a **new UUID when an object changes zone** — MTG "new object" semantics)

XMage 1.4.60 does not do this. Object continuity is already on the wire, unused. §3 has the
evidence. The consequence is that the hard, uncertain, research-shaped part of this phase does not
exist: we are not inventing a heuristic, we are forwarding an identity XMage already gives us.

## 2. Decisions

| Decision | Choice | Basis |
|---|---|---|
| Platform | **Browser, same static-SPA shape as classic** — caddy already serves `dist/` with `/ws` proxied | Iteration is the whole game this phase; a URL that is always current beats any binary your friends must install. Also keeps Scryfall's CDN + the browser HTTP cache doing the image work for free. |
| Language | **TypeScript**, unchanged | The shared core (§11) is TS and stays TS. A second language buys nothing and forks the protocol types. |
| Table renderer | **PixiJS v8** (WebGL/WebGPU, 2D-native) | The table is card choreography, not a 3D scene; Pixi is the mature 2D GPU renderer (v8.18/8.19, ~500k weekly downloads) with the filter/particle vocabulary the effects need. three.js would cost more per effect for depth we can fake with perspective transforms. |
| Chrome renderer | **React + DOM overlay** — log, chat, prompt dock, modals, lobby, hover preview body | Text-heavy, selectable, accessible, and already written. Canvas text is the wrong tool for oracle text and a 500-line scrolling log. |
| Scene model | **Flat scene of card actors + pure layout function** (§6) | Cards must not be children of zones or they cannot leave them. This single change is what makes both "unified battlefield" and "cards fly between zones" fall out instead of being fought for. |
| Coordinate spaces | **World vs screen, split at the top** (§7.1) | The table, all four boards, the piles, the stack and combat have table coordinates. Your hand, the prompt dock, log and chat have screen coordinates and never move. Every other layout question resolves once this line is drawn. |
| Table layout | **One continuous felt surface, four quadrants, one camera** (§7) | Reviewed as a mockup 2026-07-21 against an opponent-arc alternative and chosen. An arc is still a *composition of panels*; a world with a camera is a table. Attackers stepping into the middle, a shared stack, and "move the viewport at will" are all free once the boards share one coordinate system. |
| Camera | **Follows the active player, manual override, presets only** (§7.3) | Discrete presets (whole table + one per seat) interpolate predictably and unit-test trivially. Free pan/zoom is not wanted: there is no navigation problem to solve, only a "show me that player" problem. |
| Animation timing | **Two clocks** — authoritative state vs presented state, joined by a director (§6.3) | The bridge emits at machine speed; animation has duration. Anything else either drops frames of story or blocks input. |
| Input policy | **The prompt dock never waits on animation** (§6.4) | Non-negotiable. This is the specific way Arena feels bad and it is avoidable. |
| Event source | **Bridge-derived semantic events**, additive on `game.patch`/`game.state` (§4) | The bridge holds the raw `GameView` (the client only sees the trimmed one) and gets the log one callback *ahead* of the state it describes. Deriving client-side means every future client redoes it against strictly less information. |
| Protocol version | **Additive within v1** — no major bump | §13 permits new optional fields and new event types; §3 requires unknown fields be ignored. The classic client keeps working with no change at all. |
| Classic client | **Stays**, served at `/classic` | It is the fallback for friends' nights during a phase with no natural end date. |
| Milestones | Bridge continues **M6**; new client is **T0–T6** | C-numbers belong to the classic client. |

## 3. Evidence: object identity is already on the wire

Verified independently on two different full-game captures. Scanning every `GameView` in
`bridge/logs/spike-1784169224029.jsonl` and bucketing each object UUID by the zones it is ever
seen in:

```
distinct object ids: 169
     90  ('stack',)
     34  ('battlefield',)
     12  ('graveyard', 'hand')
      6  ('battlefield', 'graveyard')
      2  ('battlefield', 'exile', 'graveyard')
      1  ('exile', 'graveyard')
any bucket containing 'stack' AND another zone?  False
```

A physical card keeps **one UUID** across hand ↔ battlefield ↔ graveyard ↔ exile ↔ library.
`PermanentCard.java:44` passes `card.getId()` straight into the permanent; `CardView.java:302`
does the same into the view. What XMage bumps on a zone change is a server-side zone-change
counter that never crosses to the client.

**The stack is the sole exception** — `Spell.java:55` sets `this.id = ability.getId()`, an
ephemeral id, and `GameView.java:97` keys the stack by it. So hand → stack → battlefield is two
identities, not one.

**The log closes that gap.** Across a full game, **0 of 98** log `object_id`s were stack-ephemeral —
the log speaks exclusively in stable ids, and arrives one callback *before* the state it describes
(`seq 456` chat, `seq 457` the update carrying the new stack). Real captured lines:

```
… casts <object_id='87903dcb…'>Sensei's Divining Top</font> [879] from hand
… puts  <object_id='87903dcb…'>Sensei's Divining Top</font> [879] from stack onto the Battlefield
… moves <object_id='e39496f4…'>Knight of the White Orchid</font> [e39] from battlefield to the
        exile zone (source: <object_id='bfadc0ae…'>Path to Exile</font> [bfa])
… sacrificed <object_id='715c4020…'>Swamp</font> [715] (source: <object_id='c24461b2…'>Dust Bowl</font>)
<object_id='ab636679…'>Zurgo Helmsmasher</font> [ab6] is put into graveyard from battlefield
        (SBA: creature has toughness 0 or less)
Attacker: <object_id='994992ec…'>Tasigur</font> (4/5) blocked by <object_id='4b6b4d71…'>Daxos</font> (2/2)
```

The same `object_id` appears in "casts … from hand" and "puts … from stack onto the Battlefield".
That is the stack link, free.

Two more anchors the bridge currently discards and should not: `CardView.mageObjectType`
transitions `CARD → SPELL → PERMANENT → CARD` on the object itself, and
`StackAbilityView.sourceCard.id` is the stable source id for triggered/activated abilities
(already carried as `StackItem.source`).

**Known gaps, all covered by state deltas rather than the log:**

| Not in the log | Where it comes from instead |
|---|---|
| Tapping for mana (zero hits across ~3,000 lines) | `PermanentView.tapped` + `PlayerView.manaPool` deltas |
| Attacker identity ("attacks with 3 creatures" names no cards) | `GameView.combat` / `CombatGroupView` |
| Counter added/removed | `CardView.counters` delta |
| Opponent draws (deliberately anonymous — hidden info) | `librarySize`/`handSize` delta → anonymous event (§4) |

Also worth noting: `sync/Differ.java:9-14` already sets `OMIT_MOVE_OPERATION` /
`OMIT_COPY_OPERATION` so that a zone change surfaces as `remove` + `add`, with a comment saying it
is for "zone-change animation heuristics". The door was left open on purpose.

## 4. Protocol: the event stream (additive, still v1)

Events ride **on** the state message they explain, as an optional field, rather than as a separate
message. They are meaningless apart from that specific transition, and a client that ignores the
field degrades to exactly today's teleport rendering — which is what the classic client will do,
untouched.

```ts
interface StateKeyframe { t:'game.state'; seq; gameId; state: GameState; events?: GameEvent[] }
interface StatePatch    { t:'game.patch'; seq; gameId; base; ops; events?: GameEvent[] }

type Zone = 'hand'|'battlefield'|'graveyard'|'exile'|'library'|'stack'|'command';

type Verb = 'cast'|'play'|'resolve'|'counter'|'destroy'|'sacrifice'|'exile'|'discard'
          | 'mill'|'bounce'|'draw'|'tutor'|'put'|'token'|'attach'|'detach';

interface Cause { objectId?: Id; name?: string; playerId?: Id }

type GameEvent =
  // The workhorse. `objectId` is the stable card id on both sides of the move.
  | { k:'move'; objectId: Id; from: Zone; to: Zone; verb: Verb; cause?: Cause; reason?: string }
  // Anonymous movement — hidden information, animate as card backs.
  | { k:'hidden'; playerId: Id; from: Zone; to: Zone; count: number; verb: Verb }
  // Binds an ephemeral stack id to the stable card/source it came from (§3).
  | { k:'stackLink'; stackId: Id; objectId: Id }
  | { k:'tap'|'untap'; objectId: Id; forMana?: boolean }
  | { k:'attack'; attackerIds: Id[]; defenderId: Id }
  | { k:'block'; attackerId: Id; blockerIds: Id[] }
  | { k:'damage'; targetId: Id; amount: number; combat: boolean; cause?: Cause }
  | { k:'life'; playerId: Id; from: number; to: number; cause?: Cause }
  | { k:'counters'; objectId: Id; name: string; from: number; to: number }
  | { k:'trigger'; sourceId: Id; stackId?: Id }
  | { k:'reveal'; objectIds: Id[]; playerId?: Id }
  | { k:'shuffle'|'scry'|'search'; playerId: Id }
  | { k:'step'; phase?: Phase; step?: Step; activePlayerId?: Id };
```

Rules:

- **Events are advisory, state is authoritative.** A client must reach the same board by applying
  `ops` alone. Events only say *how it looked*. A missing, wrong, or unknown event costs an
  animation, never correctness — so the deriver may always fall back to silence.
- **`move.objectId` is the stable id.** For a hand → stack move, `stackLink` accompanies it.
- Events are ordered within the array; the client plays them in order.
- Unknown `k` values are ignored per §3's forward-compatibility rule.

## 5. Bridge: event derivation (M6)

One new stage in the §7 pipeline, between the differ and the emit:

```
ClientCallback
  → CHATMESSAGE            → LogTranslator → LogEntry  ─┐  (arrives BEFORE the state it describes)
                                                        ├→ pending verb buffer
  → embedded GameView      → ViewTranslator.trim        │
      → StateStore + Differ  (ops)                      │
      → EventDeriver ◄──────────────────────────────────┘   join: verbs ⋈ delta
      → emit game.patch{ops, events} then game.prompt
```

**The join is the design.** Log lines are buffered as they arrive; when the next `GameView` lands,
the deriver computes the state delta and correlates:

- Delta shows an object left zone A and appeared in zone B → a `move`. A buffered log line naming
  that `object_id` supplies the **verb and cause**; without one, the verb defaults to `put`.
- Buffered line with no corresponding delta (opponent draws, shuffles, scry) → an event with no
  object, or a `hidden` event sized from the `librarySize`/`handSize` delta.
- Delta with no line (tap for mana, counters) → event derived from the delta alone.

Retention this needs: the deriver needs the previous **trimmed** state and the buffered log — and,
it turned out, *only* those. This section speculated the deriver would also need a small set of
discarded fields (`mageObjectType`, `GameView.gameCycle`, `PermanentView.original`). **Implemented
(2026-07-22): it does not.** The trimmed `GameState` already encodes zone membership (which list an
id sits in), `librarySize`/`handSize`, the stack, and — for abilities — the stable source id on
`StackItem.card`; the log supplies verbs, causes, and the stable id behind a cast spell (which the
stack keys ephemerally). The coverage assertion below is green with none of the three retained, so
they were not added — the pump keeps only `lastState` (already present) plus a small drained log
buffer, and the raw `GameView` is still dropped. `PermanentView.original` returns as a real need
only at T4, for the DFC flip animation (§15.5).

**Testing is the reason this is bridge-side.** Full-game captures replay offline with no server and
no renderer. The M6 exit criterion is a coverage assertion over them: *every zone transition
observable in the state delta is explained by at least one emitted event*, with the residue
printed. That is a real, measurable, regression-testable bar, unavailable to a client-side deriver.
**Implemented (2026-07-22)** as `EventCoverageReplayTest` — **green over 20 captures / 4,816
transitions, 0 unexplained.** It replays the `CallbackTap` `.ser` streams (`bridge/logs/tap/`), not
the spike's Gson JSONL: the `GameView` graph is polymorphic and does not round-trip through Gson
(the same limitation that put the golden tier on Java serialization, bridge design §13). The `.ser`
captures are byte-faithful and run through the exact production translators; the coverage check
reimplements the zone map *independently* of the deriver so it can actually catch a bug in it.

## 6. Client architecture

### 6.1 Card actors

One persistent `CardActor` per object, keyed by the stable UUID from §3, living in a **single flat
scene** — not inside a zone container. Today `client/src/ui/board/Battlefield.tsx` builds flexbox
rows, so a card physically cannot animate out of its parent. Actors instead hold a current
transform and a target transform and interpolate.

Actors outlive zone changes (that is the whole point), are created on first sight, and are retired
only after their exit animation completes. Stack items get actors keyed by `stackId`, adopted onto
the stable id when a `stackLink` arrives.

### 6.2 Layout is a pure function — and the camera is not part of it

The world/screen split (§7.1) buys a factoring that is better than one `layout()` taking a viewport:

```ts
layoutWorld (state: GameState): Map<ActorKey, Transform>            // table coords, fixed extent
layoutScreen(state: GameState, viewport: Size): Map<ActorKey, Transform>   // hand fan, dock anchors
camera      (view: CameraView, viewport: Size): Transform           // world → screen
```

`layoutWorld` takes **no viewport and no camera**. The table is a fixed-size world; where a
permanent sits on Ana's board does not depend on how big the browser window is or where the lens is
pointed. That makes it the most testable function in the codebase: same input, same table
coordinates, forever. Only `layoutScreen` — the hand fan and anything anchored to a window edge —
sees the viewport, and only `camera` sees the view.

No side effects, no renderer types, no time in any of the three. Zones stop being containers and
become layout *functions* — `handFan()`, `battlefieldRows()`, `pile()`, `stackSlot()`,
`quadrant(seat)`. T1 therefore exits on tests rather than on screenshots.

**Crossing the boundary.** A cast starts at a screen-space hand position and ends at a world-space
stack slot. Rather than interpolate across two spaces, the director projects the hand card's screen
position into world coordinates through the **inverse camera at animation start**, then animates
purely in world space. The card is on the table from the first frame; if the camera moves mid-cast,
the card stays glued to the felt, which is the correct physical read.

### 6.3 The two clocks

- **Authoritative state** — the current `GameState`, exactly as the shared core already maintains it.
- **Presented state** — an *older, real* `GameState` that the scene currently depicts.
- **Director** — consumes `(events, nextState)` steps, plays the animations, then advances
  presented to nextState.

**Invariant: the director never synthesizes state.** Presented is always a state the server
actually sent, never an interpolation of two. Only *transforms* interpolate, between
`layout(presented)` and `layout(next)`. This makes an entire class of "the board briefly showed
something illegal" bug unrepresentable.

Catch-up policy, since XMage emits far faster than animation plays: the director tracks queue
depth and scales durations down as it grows; past a threshold it plays only the *last* step of a
run and snaps the rest. Dropping animation is always legal (§4: events are advisory).

### 6.4 Input never waits

The prompt dock renders **immediately** against authoritative state, always. It is never gated on
the director.

Board affordances (highlighting candidates, click targets) do need the board to have caught up, so
when a prompt for this seat arrives the director enters a **budgeted flush**: remaining animation
plays compressed within a hard cap (~400 ms), then snaps. You still see your creature leave your
hand; you never wait on it.

The consequence is worth stating because it is a feature, not a compromise: **your own turns are
snappy and your opponents' turns are cinematic.** With 138–379 prompts per game, that is where the
animation windows naturally are, and it is the right allocation for a four-player game where most
of the time you are watching.

## 7. The table: one world, four place settings, one camera

An opponent-arc layout was mocked up and **rejected** on 2026-07-21: it was still a composition of
four panels, just curved, and it did not feel like sitting at a table. The accepted design is a
single continuous felt surface divided into quadrants, with a camera over it. Mockup:
`claude.ai/code/artifact/59d8b97f-b47f-4580-b366-e8f9f6cfe6a0`.

### 7.1 Two spaces

| | World space | Screen space |
|---|---|---|
| Contains | felt, four quadrants, all battlefields, all piles, the stack, combat, attack arrows | your hand fan, prompt dock, log/chat, turn ribbon, compass, toasts, modals, fatal overlay |
| Coordinates | fixed table units, independent of window size | CSS pixels, anchored to window edges |
| Moves when the camera moves | yes | **never** |
| Laid out by | `layoutWorld(state)` | `layoutScreen(state, viewport)` |

Everything in §7 that reads as a design decision is a consequence of this table.

### 7.2 The world

```
       ┌───────────────────────┬───────────────────────┐
       │  ▣ Marta 31   [pile]  │  [pile]  ▣ Tom 40 ◐   │   far half:
       │  ▭ ▭ ▭ ▭ ▭ ▭  lands   │   lands  ▭ ▭ ▭ ▭ ▭    │   plate, lands,
       │  ▭ ▭ ▭ ▭ ▭ ▭  spells  │  spells  ▭ ▭ ▭ ▭      │   spells forward
       ├───────────────────────┼───────────────────────┤
       │            ╭── stack ─┴──────────╮            │   the seam:
       │            │ Swords → Muldrotha  │            │   stack + combat
       ├───────────────────────┬──────────┴────────────┤
       │  ▭ ▭ ▭ ▭ ▭ ▭  spells  │  spells  ▭ ▭ ▭        │   near half:
       │  ▭ ▭ ▭ ▭ ▭ ▭  lands   │   lands  ▭ ▭ ▭ ▭ ▭    │   mirrored —
       │  ▣ You 34     [pile]  │  [pile]  ▣ Ana 22     │   spells forward
       └───────────────────────┴───────────────────────┘
```

- **Seats are quadrants; you are bottom-left**, and turn order runs clockwise from there — up the
  left side, across the top, down the right: displays 0 bottom-left, 1 top-left, 2 top-right, 3
  bottom-right. Your seat is fixed regardless of actual seating order in the lobby. *Shipped
  counter-clockwise until 2026-07-30 (Issues.txt #17)*: two corner tables encode this (`world.ts`
  `CORNER_BY_DISPLAY` places the cards, `camera.ts` `seatCorner` frames them) and both ran the
  other way, so play appeared to move right-then-up while the compass and `1`–`4` keys ran against
  it. They must agree; `camera.test.ts` now asserts the direction by signed area.
- **The world is always four seats**, so its extent is a constant and never a function of the player
  count. Short lobbies are filled with server AI at start (`lobby.start { fillAI }`, protocol §4) and
  those seats arrive in `LobbyState.seats` and `GameState.players` indistinguishable from humans —
  the table client needs no notion of an empty quadrant, and AI turns animate like anyone else's.
- **Each quadrant is a place setting, not a panel.** No borders, no background, no card. A seat is
  located by its brass nameplate at the outer edge, its piles at the outer elbow, and a soft pool of
  lamplight — all of which sit *on* the shared felt. The only marks on the cloth are the quarter
  folds, and they stop well short of the edges.
- **Spells face the middle, lands sit behind them**, mirrored across the seam, exactly as people lay
  out a real table. Combat therefore happens across the centre by construction.
- **The seam belongs to the stack and to combat.** Attackers physically step off their own half into
  it, and attack/block arrows are drawn on the felt *under* the cards, so an arrow reads as chalk on
  the table rather than an overlay floating above it. Because the arrow can be occluded, the
  defending player also carries the state directly — nameplate turns to danger, with incoming
  unblocked damage on it.
- **Auras and equipment are not permanents of their own on the felt.** They tuck under the thing
  they are attached to, offset just enough for the name bar to clear the host's top edge, and the
  cluster turns as one when the host taps. The host may be in another seat's quadrant (your
  Pacifism on their creature) or out in a battle lane (a sword on an attacker) — the attachment
  follows it, and dims with the board it is lying on.
- **Cards always billboard upright.** Rotating opponents' cards to face their own seat is the
  literal table and it is unreadable; seat identity is carried by the furniture instead. This is a
  deliberate break from realism and the only one.
- **Opponents' hands are on the table, face down and fanned.** The count is public information, so
  render it as objects; six card backs beats the string "Hand 6".

### 7.3 The camera

```ts
type CameraView = 'table' | SeatId;
interface CameraPreset { x: number; y: number; scale: number; tilt: number }
```

One transform on the world container. Discrete presets only — the whole table, plus one per seat.
There is no free pan or zoom: the user's problem is "show me that player", not navigation.

- **It follows the active player by default**, and re-frames on turn change — including the
  **first** active player it ever sees. *Amended 2026-07-30 (Issues.txt #5/#6):* before the first
  turn there is no active player at all (XMage sends no turn structure during the mulligan window,
  protocol §6), and the original policy also skipped the first sighting so the whole quadrant world
  would read on load. Together those left the lens on the whole table through mulligans **and** the
  entire opening turn. The pre-game view is now **your own seat** — a mulligan is a decision about
  your hand, and four empty quadrants tell you nothing — and the first active player is followed
  like any other turn change.
- **A combat declaration frames the whole table**, not just declared attackers. *Added 2026-07-30
  (Issues.txt #7):* declared attackers standing on the board already pulled back, but at the moment
  you are *choosing* attackers nothing is declared and `state.combat` is empty, so your own combat
  opened with the lens on your own quadrant — hiding the players you were picking between. The ask
  itself now holds the table, and the two holds (board, declaration) are independent.
- **Manual override**: click a quadrant, use the compass, or press `1`–`4`. The badge switches from
  *Following* to *Viewing* and auto-follow stops until released with `Esc`. An override is sticky —
  the camera never yanks itself away from something you chose to look at. **One exception, and only
  one:** a prompt naming an object the lens cannot see pulls back to the whole table (§14). Nothing
  else breaks a pin.
- **A focused seat is framed against the middle of the table, not centred in the window.** Centring
  spends a third of the window on empty rail behind the player; framing them toward the far edge
  keeps the contested ground and the neighbouring boards in shot. Measured on the mockup, not guessed.
- **Neighbours bleed in at the edges.** The zoom is deliberately short of filling the window, because
  seeing the edge of the next board is what proves it is one table.
- **Tilt eases flatter as the camera comes in** — ~15° at the whole table, ~6–10° on a seat. Leaning
  in over a table is the metaphor and it costs one interpolated number.
- **Unfocused seats dim with a filter on their cards, never a scrim over their region.** A scrim
  would redraw the exact box edges this layout exists to remove.

Camera moves are the director's (§6.3), so they queue, scale and flush with everything else, and
`prefers-reduced-motion` collapses them to cuts.

At whole-table zoom, card names are legible as shapes rather than text — you read art, colour and
board shape, then fly in to read. Confirmed acceptable at review; the two-tier texture policy (§10)
is sized for exactly this.

## 8. Zones as physical objects

The brief was explicit that graveyard and exile should stop being lists in a floating box.

All of these live in world space, at their owner's outer elbow (§7.2).

- **Graveyard / exile / command** render as real stacked piles on the table, with per-card offset
  and rotation jitter derived deterministically from the card UUID (never `Math.random()` — it must
  be stable across frames and reloads). Depth reads as thickness, so a 12-card graveyard *looks*
  like twelve cards, and the **top card is face up** so the pile says what is in it.
- Clicking a pile **spreads it across the table** in place rather than opening a modal — the C5
  filter/sort work carries over as a spread-view control strip. Clicking an opponent's pile flies the
  camera to that seat first, so the spread is always read in its owner's space.
- **Library** is a pile too, so draws and tutors have somewhere to physically come from, and mill
  has somewhere to fall off.
- **Exile gets its own visual language** — cold, drained, offset off-table — so "gone" and "dead"
  are never confused at a glance.
- An **empty pile leaves its footprint** on the felt rather than disappearing, so the place setting
  does not reflow when the last card leaves.
- **Hand** is the one zone in screen space (§7.1): a fan with hover-lift, pinned to the bottom edge,
  visible no matter where the camera points. Cast animates from the actual card position in the fan,
  projected into world space on the first frame (§6.2).

## 9. Animation catalogue

Driven entirely by §4 events. First pass, in the order they earn their keep:

| Event | Motion |
|---|---|
| `move` hand→stack (`cast`) | card lifts from the fan, arcs to the stack slot, scales up, glows by colour identity |
| `move` stack→battlefield (`resolve`) | drops onto the board with a landing squash + dust ring |
| `move` library→hand (`draw`) | slides from the library pile into the fan; opponents' draws use `hidden` and show backs |
| `move` hand→battlefield (`play`, land) | short direct arc, softer landing |
| `tap` / `untap` | 90° rotation with overshoot ease; `forMana` adds a brief mana-coloured pip toward the pool |
| `attack` | attacker marches to the border its quadrant shares with its defender's — a row along the horizontal seam, a column along the vertical seam, or the table's centre corner (tilted 45° toward the diagonal) — crossing the line slightly; chalk arrow drawn on the felt under the cards; defender's nameplate turns to danger with incoming damage |
| `block` | blocker stands directly across the border from its attacker, in line with it and matching its rotation; the blocked attacker backs onto its own side; the pair rims to a common colour |
| `damage` (combat) | whoever is punching lunges there-and-back: an attacker at the defender's nameplate, or falling just short into the blocker that stopped it, and a blocker back at its attacker; the impact flash, damage number and screen-shake land at the moment of the hit, not at takeoff |
| `life` | number tumbles up/down at the seat; red vignette pulse on large losses |
| `move` battlefield→graveyard (`destroy`) | card desaturates, tips over, falls onto the graveyard pile |
| `move` …→graveyard (`sacrifice`) | different read from destroy: brief self-consuming flash, no attacker arrow |
| `move` …→exile | rises and fades off-table into the exile pile, cold-toned |
| `counters` | pip pops onto the card with a small bounce |
| `trigger` | source card pulses and a ribbon spawns toward the stack |
| `counter` (spell countered) | stack card shatters instead of resolving |
| `step` | phase ribbon sweeps; untap step drives a rippling untap across the board |
| `step` with new `activePlayerId` | camera re-frames to the new active player, unless the view is manually pinned (§7.3) |

## 10. Rendering notes

React and Pixi coexist: Pixi owns one canvas that fills the viewport; React renders the chrome above
it. The world/screen split (§7.1) maps almost exactly onto the renderer split — world space is Pixi,
screen space is DOM — with the deliberate exception of the **hand**, which is screen-space but must
be rendered by Pixi so a card can leave it and fly to the table as one continuous actor.

The one real coupling is anchoring DOM to scene coordinates (hover previews, popovers, seat menus)
— a `sceneToScreen(actorKey)` helper on the director that composes `layoutWorld` with the live
camera, sampled per frame while an anchor is open. Because the camera can move under an open
anchor, anchors must track rather than position once.

**Texture LOD is not optional.** A Scryfall card face is ~488×680; as RGBA that is ~1.3 MB
uncompressed on the GPU, so 300 cards at full resolution would be ~400 MB of VRAM. Two tiers:

- **Table tier** ~200×280 (~224 KB each) — everything on the board, in hands, in piles. 300 cards
  ≈ 67 MB. Fine.
- **Detail tier** full resolution — only the hover preview and the focused/stack card, a handful
  live at a time, evicted on an LRU.

Face-down cards and the text-frame fallback (`docs/client/design.md:225-228`) both stay: an
unresolved image must remain fully playable, so the text frame is rendered into a texture rather
than dropped.

## 11. Repo layout & the shared core

```
packages/core/          # extracted from client/src, npm workspace @night/core
    protocol/  net/  stores/  state/  images/scryfall.ts
client/                 # classic client — unchanged behaviour, now imports @night/core
table/                  # the new client
    src/ scene/         # CardActor, director, two-clock queue
         layout/        # layoutWorld / layoutScreen — pure, no renderer types (§6.2)
         camera/        # presets, follow policy, world↔screen projection (§7.3)
         render/        # Pixi: sprites, filters, particles, texture LOD
         chrome/        # React DOM: prompt dock, log, chat, modals
```

The extraction is the risky part of T0, because `client/` is deployed and working. It is gated on
the classic client's existing tiers staying green — unit, corpus, replay, and the `test:preview`
production-bundle run. That suite is exactly what this refactor is for.

`images/scryfall.ts` moves wholesale: URL resolution, rate limiting, and the localStorage cache are
shared. Only the *rendering* of the resolved image differs between the two clients.

## 12. Testing

| Tier | What | How |
|---|---|---|
| Bridge event coverage | every state-delta zone transition explained by ≥1 event | **done (M6):** `EventCoverageReplayTest` replays the `.ser` full-game captures offline; residue empty, printed. Green over 20 captures / 4,816 transitions |
| Bridge event unit | the log⋈delta join per transition kind | **done (M6):** `EventDeriverTest` — cast+stackLink, resolve, land, destroy+cause, sacrifice, mill, opponent-draw hidden, own-draw visible, ability link, token, step, empty |
| Bridge event wire shape | `events?` array reproducible; classic client unaffected | **done (M6):** `game.patch.events.json` conformance sample (one of each M6 kind); existing goldens byte-identical (single-callback fixtures carry no prior state, so no events — the additive field is simply absent) |
| Layout unit | `layoutWorld()` at many board densities; `layoutScreen()` at many viewports | pure functions, headless vitest — no canvas, no renderer. `layoutWorld` takes no viewport, so its cases are board states only |
| Camera unit | preset framing, follow policy, override stickiness, `worldToScreen`/`screenToWorld` round-trip | pure; assert every seat's quadrant lands fully inside the viewport and clear of the hand at every supported window size |
| Director unit | queue depth, duration scaling, budgeted flush, snap | drive with synthetic event steps and a fake clock |
| Replay | recorded sessions re-driven through core + director | asserts no dropped steps, presented converges to authoritative, zero synthesized states |
| Live E2E | the auto-player and the resilience spec, driving either client | **semantic contract landed at T0, the driver went semantic at T5** — one spec set in the root `e2e/` workspace, selected by baseURL. See below |

The Playwright cost is real and worth naming. `window.__night` used to be a read-only `snapshot()`,
and the auto-player drove the DOM by selector. A canvas table is opaque to that. So the harness grew
a **semantic action API** — `click(objectId)`, `answer(...)`, `pass()`, plus a `scene()` accessor
exposing actor keys, positions and animation state. This is a genuine improvement: the auto-player
starts expressing game intent instead of CSS structure, and the same specs then run against both
clients.

**Brought forward to T0** (2026-07-22, at Ricardo's call: retrofitting it after T4 is harder than
growing it alongside the client). The contract now lives in `@night/core/harness` as `NightHarness`
— the view-independent half (`snapshot` + `click`/`answer`/`pass`, all backed by the shared
stores/actions) is implemented once in core; only `scene()` is client-specific (classic derives it
from state via `sceneFromState`, the table reads its live Pixi actors). Both clients `installHarness`
from their first commit, so the table client is never opaque to Playwright. The driver types against
`@night/core/harness`, not a client's internals. **Deferred:** physically relocating the spec files
from `client/e2e` to a shared root `e2e/` (so one spec drives either client by baseURL) waits until
the table client is actually drivable (T2–T3) — the shared *contract* is the part that had to exist
early, and it does; moving spec files now would be churn with no target to point at.

**Closed at T5** (2026-07-24). The specs now live in a root `e2e/` workspace (`@night/e2e`) and drive
either client by baseURL — `npm run e2e:table` / `e2e:classic`, plus `:preview` variants for the built
bundles; `NIGHT_CLIENT` picks the target, `NIGHT_BASE_URL` overrides it (a deployed host). The driver
became genuinely semantic: it reads the pending prompt itself off `window.__night.prompt()` — the
wire's §8 payload plus the selection scratch and my mana pool — and decides a first-legal answer from
*that*, submitting through `click`/`answer`/`pass`. Previously it recovered the prompt's meaning from
the dock's DOM (option keys, pool colours, distribute rows, combat highlights), which a canvas board
cannot show. Two things stay deliberately view-observed, because they are what the specs are for: the
dock must really render for the pending prompt (DOM in both clients, identical markup), and the client
must expose ≥1 enabled control for it — §13's no-dead-end invariant, now `dock buttons +
harness.highlights()`, where `highlights()` is the second view-specific accessor beside `scene()`
(classic reads its `.hl-*` DOM rings; the table reads its ringed Pixi actors). The board-ready probe
went from counting `.seat-panel` nodes to `snapshot().seats`, since the table draws its seats on the
felt. What this trades away, stated plainly: the driver no longer proves a dock *button* is wired to
the right answer, only that an enabled control exists — per-kind dock rendering now rests on that
invariant plus live review. The harness contract itself is unit-covered
(`packages/core/test/harness.test.ts`, 13).

## 13. Milestones

| # | Deliverable | Exit criterion |
|---|---|---|
| M6 | ✅ **done 2026-07-22.** Bridge event derivation: `EventDeriver` log⋈delta join, `move`/`hidden`/`stackLink`/`step` on the additive `events?` field (protocol §7.1) | Coverage assertion green over **20 captures / 4,816 transitions, 0 unexplained**; classic client provably unaffected (existing goldens/corpus byte-identical). Retention of `mageObjectType`/`gameCycle`/`original` proved unnecessary (§5); T4 event kinds frozen but not yet emitted — **now emitted at T4** (see the T4 row) |
| T0 | ✅ **done 2026-07-22.** npm workspaces; `@night/core` extracted (protocol/net/stores/state/images/dev + the `deeplink` helper + the shared `harness`); `table/` scaffolded (Pixi v8 + React); `CardTextures` two-tier LOD (text-frame faces = the §10 image fallback), `CardActor` flat scene, `layoutFlat`, `TableScene`; the **semantic harness contract** (`snapshot`+`scene`+`click`/`answer`/`pass`) brought forward from T5 into `@night/core/harness`, both clients install it | **Met.** Classic suite green post-extraction (core 219 · client 30); the classic prod bundle is **byte-identical** (228,730 B — the extraction is byte-neutral, proven by pinning react back), so the deployed client is provably unaffected. One caveat found and handled: the workspace `npm install` floated react/react-dom 19.2.7→19.2.8 (a patch within the `^19.2.7` range, +47 KB, unrelated to the extraction); a root `overrides` holds them at 19.2.7 to keep the baseline. A synthetic 4-seat keyframe renders as a recognizable table (headless-WebGL screenshot: 36 actors, four nameplates, piles, stack, hand, opponent backs). Also closed M6's client-side gap: `@night/core` now knows the additive `events?` field (types + strict decoder), so `npm run dev`/dev-strict no longer reject event-bearing patches |
| T1 | ✅ **done 2026-07-22.** Quadrant world layout (place settings, battlefield rows with spells toward the seam and lands strictly behind, piles at the outer elbow, opponent hands as upright backs, the shared stack on the seam) + camera rig (`table` + one preset per seat, follow/override controller, §14 pull-back) + screen-space hand fan. No animation — instant cuts | **Met.** `layoutWorld`/`layoutScreen`/`camera` are pure and unit-tested headless (36 table tests: densities incl. a 20-permanent board, six viewports 1280×720 → ultrawide, projection round-trip, follow/override stickiness). Exit assertion **every seat preset frames that seat fully in view and clear of the hand at every supported window size** is green. No client-format session capture exists yet (as at T0), so "recorded session frame-by-frame" is stood in for by the density/viewport matrix plus a headless-WebGL render of the demo keyframe at whole-table and both seat presets. `layoutFlat` (T0) retired |
| T2 | ✅ **done 2026-07-22.** `Director` (Pixi-free, `scene/Director.ts`): two clocks, a step queue, catch-up (duration scaling → snap through a deep backlog) and `flush` (§6.4). The scene is its `DirectorSink` — survivors tween between layouts, new actors fly in from the zone their `move` names, cards crossing the world↔screen seam are re-projected (§6.2). `stackLink` adoption (`scene/keys.ts`) unifies cast → resolve onto one actor (§3). `CardActor` is now a duration-based tween in lockstep with the director's clock. Events reach the client on the game store's `lastEvents` (set in `state/apply.ts`); the director snaps eventless/new-game transitions (the §7.1 teleport fallback) and animates the rest. Camera moves (follow, manual, §14 pull-back) interpolate through the director; `prefers-reduced-motion` cuts | **Met.** Director unit (`director.test.ts`, 14): snap/animate decision, convergence, **zero synthesized states**, backlog scaling, deep-backlog snap + bounded drain, flush cap, camera follow/override/tween/§14. Replay (`session.test.ts`) drives a synthetic event-bearing session through **@night/core + director**: presented visits every real state in order (no dropped steps) and converges; **zero teleports** proven as a pure key-continuity property over `layoutKeyed` (every visible move keeps one tracked actor across the transition); budget cap holds under a one-frame burst. `keys.test.ts` (4) covers stackLink adoption/prune. Headless-WebGL boot smoke: the full seed → store → director → ticker → WebGL pipeline renders 68 actors across all zones with zero runtime errors. Pixel-level feel (easing, dust rings, squash) is T4 |
| T3 | ✅ **done 2026-07-23.** Interaction parity: the table client is fully interactive — home → lobby → game over the felt, the shared `@night/core` stack dialed to the bridge (`bootApp` connects; `?demo` still seeds the offline table). All prompt kinds in a canvas-overlay `PromptDock` (modal card-grids for choosePile / distribute / playerRequest / off-board chooseTargets; the §13 stranded-target dock so a graveyard pick is never a dead end). Canvas hit-testing routes every click through the shared `affordanceFor` model (`scene/interaction.ts` — Pixi-free, so headless-testable), affordance rings on the felt, hover previews anchored to live actors via the camera (§10 sceneToScreen), quadrant-click + `1–4` / `` ` `` / `Esc` camera control, one unified keyboard handler (game shortcuts + camera, Esc shared), and the log/chat + turn-controls + banners + rematch + toasts + fatal chrome. §6.4 flush + §14 pull-back fire on each new this-seat prompt. Classic chrome ported into `table/src/chrome/`; classic client untouched (§14 risk) | **Engineering met**, verified as far as headless allows: table **57→71** (affordance→highlight parity over the shared model incl. manaOnly-never-clickable, quadrant hit-test, world→screen anchor, §14 prompt-object scope); classic still byte-green (core 220 · client 30). Headless-WebGL boot smoke: Home boots + installs the harness with zero runtime errors; `?demo` renders 68 actors with overlay/log/controls/compass mounted; a canvas hover pops the DOM preview; a felt tap focuses that quadrant. Needed a `resolve.dedupe:['react','react-dom']` in the table vite config — the T0 overrides pin keeps react per-package while zustand hoists to root, so bundling zustand's `import 'react'` was otherwise unresolvable at load. **Exit criterion — a human plays a full game vs 3 AIs to `game.over` — is the remaining live step** (the switchable gate). On-felt pile-spread (§8) and the juice (rings→glow, combat, damage, particles) are T4. **Exit criterion met 2026-07-23:** Ricardo played a full game vs 3 AIs through the table client to `game.over` on a local stack — the switchable gate is cleared |
| T4 | The juice — tap/untap, combat choreography, damage, death, sacrifice, counters, life numbers, particles, camera easing. Also the two legibility items deferred from review: **tapped-card readability under crowding** and **keeping the stack findable when the camera is on a corner** | Iterative and subjective by nature; reviewed at the table, not by assertion. **Phase A done (bridge events):** `EventDeriver` extended to emit every §7.1 kind (`tap`/`untap`, `attack`/`block`, `damage`, `life`, `counters`, `trigger`, `reveal`, `shuffle`/`scry`/`search`) from the same state-delta ⋈ log join; `@night/core` decodes them; conformance sample (`game.patch.events.json`) covers one of each; `EventDeriverTest` +12 cases (incl. the ability-description no-false-fire guard); the live `EventCoverageReplayTest` stays **0 unexplained / 4,816 transitions** and every new kind is confirmed firing on the 20 real captures (tap 4206, untap 3782, trigger 1193, life 835, attack 574, damage 438, counters 132, search 71, block 34, scry 29, reveal 25; shuffle folded into fetch activations, silent by design). **Phase B (client §9 catalogue) engineering done:** a Pixi `Effects` layer (dust rings, mana pips, damage numbers, impact flash, chalk attack arrows, trigger ribbons + ephemeral ghosts, phase ribbon, life vignette, screen-shake) + `CardActor` juice channels (path arc, landing squash, tap overshoot, colour glow, white flash, death desaturate + tip-over) driven from the event stream in `TableScene.playJuice`; the **trigger-ghost adoption fix** landed (`layoutKeyed` no longer drags a permanent onto the stack for an ability — it keeps its ephemeral key, source stays put). Gated on `duration>0` so reduced-motion / snap cuts play no juice. Verified: table **77** tests green (incl. the new ability-adoption case, zero-teleport replay intact), and the scripted `?demo=juice` reel plays every catalogue row through the real store→director→scene path headless with **zero runtime errors**. Pixel feel/tuning is Ricardo's live review. **Live review (2026-07-24) found several §9 rows missing or broken in practice; second pass fixed them:** attack/block became *layout* (`layoutWorld` reads `state.combat`: attackers step off their half into the seam leaning toward their defender, blocked attackers nudge back, blockers slide out to interpose, and the defender's nameplate turns to danger carrying the incoming unblocked damage); `counter` now shatters the stack card into tumbling shards (the actor hides, reappearing as the pile top); `sacrifice` reads as a self-consuming implosion, distinct from destroy; exile rises cold and half-faded off the table, keyed on `to:'exile'` rather than the verb (the bridge only says `exile` for battlefield exiles — the rest arrive as `put`); the cast glow holds through the flight and blooms visibly; and the death desaturate/tip-over eases off after the fall lands — and on any later zone change — instead of leaving the graveyard's top card permanently grey and tipped (reanimation arrived corpse-tinted before). `actorByObject` is zone-aware, so an ability sharing its source's id can no longer steal the source's juice. The `?demo=juice` reel grew from 4 to 15 beats covering every previously-unexercised row (block, resolve, sacrifice, exile, counter); combat layout is unit-tested (`world.test.ts`, table now 124 assertions). **Third pass (2026-07-24, Ricardo's "3-zone" design):** combat layout became the three battle lanes of §9's `attack` row — attackers march to the border shared with their defender (horizontal-seam row / vertical-seam column / 45°-tilted centre corner), each seam lane centred on its stretch of border and stopping clear of the corner zone; blockers stand directly across the border in line with their attacker at matching rotation; and the damage step delivers a there-and-back **lunge** (`CardActor.lunge`) at the blocker (falling just short), the trading attacker, or the defender's nameplate, with the impact flash/number/shake delayed to the strike. One-lunge-at-a-time sequencing in log order is deferred. The reel's attack beat now swings at all three opponents at once, manning every lane. |
| T5 | Resilience parity — resume, recovery join, bumped, rematch, post-game; semantic Playwright harness; auto-player + resilience specs green | Both e2e specs pass against the new client through the semantic harness. **Engineering done 2026-07-24.** The browser tier moved out of `client/e2e/pw` into a root `e2e/` workspace (`@night/e2e`) that drives *either* client by baseURL (`npm run e2e:table` / `e2e:classic`, `:preview` for the built bundles, `NIGHT_BASE_URL` for a deployed host) — the §12 relocation deferred at T0. The driver went semantic: it reads the pending prompt off `window.__night.prompt()` (the §8 payload + selection scratch + my mana pool) and answers through `click`/`answer`/`pass`, instead of recovering the prompt's meaning from the dock's DOM — which a canvas board cannot show. Harness additions: `prompt()`, `highlights()` (view-specific, beside `scene()`), `snapshot().seats` (replaces counting `.seat-panel` nodes) and `snapshot().socket`; `answer`/`pass`/`click` take the promptId they were decided for, so a supersede mid-decision drops the answer instead of misapplying it (the dock had that for free by capturing the id it rendered with). The contract is now unit-covered (`packages/core/test/harness.test.ts`, 14). Verified: table **126** tests green, classic **30**, core **236**. **Exit criterion met 2026-07-24 — both specs green against the table client.** The auto-player: a full patch-mode game vs 3 AIs to `game.over` in 2.8 min, ≥1 combat declared through the board, 2,450+ patches applied, 0 resyncs / 0 divergences. The resilience spec (12.6 min): two browsers, mid-game reload on *both* seats with the same `promptId` re-rendered, chat both ways with the unread badge, the bumped round-trip (second tab steals the seat → takeover screen → *Use here* steals it back), a cleared-storage **recovery join** that reclaimed the live seat by name and landed on that exact pending prompt, game 1 to `game.over` on every seat, then a **rematch into a second completed game** — all of it over the felt, with the board driven entirely through the semantic harness. The two-browser smoke also passes (12 s). Four things the live runs caught, all fixed: (1) the no-dead-end invariant counted only `<button>`s and so read a **modal card grid** as a dead end — Mosswort Bridge's Hideaway is a *required* single-target pick over library cards, so there is no Submit, no Decline and nothing on the felt to ring, and the four `div[role=button]` grid cards were the whole affordance; the dock also stopped claiming "click a highlighted target" over a grid where nothing is highlighted. (2) The assertion now *polls* — React DOM and the Pixi rings can legitimately be one frame apart, and a dead end is a sustained absence of any way to answer, not a one-frame one. (3) A dead socket was invisible: it looks exactly like waiting on the AIs (`promptId === null`) and the stuck detector only watches a *pending* prompt, so when the dev server died mid-run the specs polled on for another 8 minutes — hence `snapshot().socket` and a 60 s not-ready guard. (4) `attachConsole` forwards the browser's own warnings into the run (filtered: a network that can't reach Scryfall emits one CORS error per card and buries everything). **The classic client is unregressed by the shared driver: all three specs green against it too** (`npm run e2e:classic`, 13.9 min — auto-player 4.6 min with 21 keyframe-verify probes over 2,124 patches and 0 divergences, resilience 5.2 min, two-browser 4.1 min). One spec set, both clients, same afternoon. Two further fixes the tier needed, neither about the table client: the §6 keyframe-verify probe was gated on `import.meta.env.DEV`, so it was off in exactly the built-bundle tier whose auto-player asserts `verifies ≥ 1` — both clients now gate it on the same `HARNESS` flag as the `window.__night` handle (dev, or `--mode harness`; the deploy path ships neither, re-verified). And far more serious — see §14 — **the classic client's production build had been emitting a bundle with no UI at all**, exit 0. **Open:** one clean preview-tier run (`npm run e2e:classic:preview`) has not completed since those two fixes; the built bundle boots, connects and plays, but the run was cut short. |
| T6 | Friends' night on the new client, classic still at `/classic` | A real four-human game played on the table client |

T3 is the milestone that matters strategically: everything before it is unswitchable, everything
after is polish on a working client.

## 14. Risks

- **Event derivation gaps.** Mana tapping is unlogged, attacker identity comes from the combat
  view, counters from deltas. Mitigated structurally: §4 makes events advisory, so any gap costs an
  animation and never correctness. The M6 coverage assertion is what stops gaps from being silent.
- **The `@night/core` extraction destabilises the working client.** The single riskiest change in
  the phase, done first and deliberately, while the classic client's four test tiers still describe
  its behaviour exactly. **This risk did materialize, in the one place the four tiers do not look:
  the production build.** Found at T5 (2026-07-24). The workspace layout — react pinned per package
  by the root `overrides`, zustand hoisted to the root — leaves the hoisted zustand's `import 'react'`
  unresolvable, and rolldown answers that by emitting a top-level `throw Error("Could not resolve
  \"react\"…")` and dropping every module after it, with exit code 0. The table client hit this at T0
  and fixed it with `resolve.dedupe`; nobody added the same line to `client/vite.config.ts`, so
  `cd client && npm run build` produced a 229 KB bundle containing react, `@night/core` and *no UI at
  all* — a blank page — while reporting success. The unit tiers run on source and never saw it, and
  the one tier that would have (the C5 built-bundle smoke) is live-only, so it hadn't run since.
  Fixed by mirroring the dedupe; the bundle is 276 KB with its UI back. Two lessons recorded in
  CLAUDE.md: every client package needs the dedupe line, and a build's *size* is not evidence — grep
  the output for one of its own class names.
- **VRAM.** Addressed by the two-tier texture policy (§10); the failure mode without it is a
  browser tab crash mid-game, not a slow frame. Worth an explicit soak with four crowded
  battlefields.
- **Canvas kills the e2e specs** until the semantic harness lands (T5). Between T2 and T5 the new
  client has weaker automated coverage than the classic one — which is precisely why the classic
  client stays deployed and why T3's exit is a human-played game.
- **Two hit-test systems.** Pixi owns the table, DOM owns the chrome; overlapping regions need one
  clear owner per pixel. Cheap to get wrong, cheap to fix, annoying to leave ambiguous. The camera
  makes it slightly worse than it sounds: a table click must be unprojected through the live camera
  before it means anything, and the compass and hand sit *over* the table.
- **A card can be off-screen when it needs your attention.** The camera is the feature and also the
  hazard — a trigger, a target, or a prompt can concern a permanent the lens is not pointed at.
  **Policy: pull back to the whole table, do not fly to the object.** A prompt whose objects are not
  all visible resets the camera to `table` before the dock becomes actionable; the re-frame is inside
  the §6.4 budget, not additional to it. Pulling back is right for three reasons: a prompt over
  candidates in *several* seats has no single seat to fly to; the whole table is the one preset that
  can never be wrong; and a hard cut to an opponent's corner disorients in a way that zooming out
  does not. Untested until T3; the failure mode is a player who cannot find what they are being
  asked about.
- **No natural end.** "Animate everything" has no exit criterion. T3 is the defined switchable
  point; T4 is explicitly open-ended and should be time-boxed per iteration rather than scoped.

## 15. Open questions

1. **`docs/protocol/v1.md:352-357` is factually wrong** (§3) and should be corrected in place
   regardless of what else happens, since it currently argues against work we now know is easy.
   Proposed as a standalone edit, not folded into M6.
2. **`ChatMessage.soundToPlay`** is a coarse XMage-side event classification the bridge ignores
   entirely. Possibly a free extra signal for the deriver; unexamined.
3. **Tokens on the table.** Token identity is `imageNumber`-discriminated (protocol §6), and tokens
   ceasing to exist needs its own animation distinct from dying. Deferred to T4.
4. **Spectators.** `role:'spectator'` is still reserved. The quadrant world needs no change for it —
   drop the screen-space hand, free the camera from any "own seat", and the whole table is already
   the default view — but nothing is designed or tested against it.
5. **DFC / transform animations.** `PermanentView.original` gives us the pre-transform face with the
   same id, so a real flip animation is available — the state model still sends one face
   (protocol §16.4).
