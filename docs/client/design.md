# Commander Night — Web Client Design (implementation spec)

**Date:** 2026-07-18 · **Status:** DRAFT for review · **Scope:** the TypeScript web client —
the static browser app that speaks protocol v1 to the bridge and carries a player from lobby
code to `game.over`. The other side of the wire is already built and live-verified (bridge
M0–M5); this client is the remaining piece before the real friends' night.

Companion documents:

- `docs/protocol/v1.md` — the wire contract this client implements. Message shapes, prompt
  kinds, and answer types are **normative there**; this doc does not restate them. Its schema
  blocks are transcribed verbatim into `client/src/protocol/protocol.ts` (that was the stated
  intent of v1.md §preamble) — wire changes happen in v1.md first, then `protocol.ts` follows.
- `docs/bridge/design.md` — the daemon on the other end of the socket (cited as *bridge §N*).
- `docs/protocol/samples/` — the conformance corpus (48 samples). The bridge asserts it via
  `ProtocolSamplesTest`; this client asserts the **mirror direction** (§14 here) so the two
  codebases never drift silently.

## 1. Decisions (proposed 2026-07-18)

| Decision | Choice | Basis |
|---|---|---|
| Runtime shape | **Static SPA, no server of our own** — `vite build` output served by the existing caddy, which also proxies `wss://…/ws` to the bridge (bridge §2) | The bridge is the only backend; adding a Node runtime would be a second daemon to deploy and keep alive for zero function. Dev mode: Vite's dev server proxies `/ws` → `127.0.0.1:8484`. |
| Toolchain | **Vite + TypeScript `strict`**, npm, current Node LTS | Boring, fast, static output; no lockstep with the bridge's toolchain. TS strict because `protocol.ts` is the load-bearing artifact. |
| UI framework | **React 19** | Deliberately a low-stakes choice: all protocol state lives in framework-free stores (§4), so React is only the render layer. Largest ecosystem for later wants (drag, animation), most boring failure modes. |
| State | **zustand** — vanilla stores + React bindings | The protocol layer writes stores without importing React (testable headless, incl. the Playwright auto-player's assertions); per-card selector subscriptions keep patch-driven re-renders cheap. Mirrors the bridge's one-owner rule (bridge §4) as *one owning store per piece of mutable state*. |
| Patch application | **fast-json-patch** | Named as the compatibility target when the bridge restricted zjsonpatch to `add`/`remove`/`replace` (bridge §1); the corpus and dev-mode keyframe verification (§13) guard the pairing. |
| Message validation | **Hand-rolled `decode(json): Msg`** with per-type narrowing; strict in dev/test, lenient in prod (unknown `t`/fields ignored per protocol §3) | A schema library would be a second transcription of v1.md that can drift from the first. The corpus is the real conformance guard; runtime strictness beyond it buys nothing in prod. |
| Styling | **Hand-written CSS** (CSS modules), dark tabletop theme; no component library | The board is bespoke layout work either way; a component library earns its bundle nowhere on this UI. |
| Navigation | **No router lib** — a screen enum (`home → lobby → game → postGame`) driven by session/lobby/game stores, plus one hash deep-link: `#/join/<CODE>` | The screens are a pipeline, not a site. The deep link is the whole invite UX: the host sends one URL and friends land in the join form with the code filled. |
| Card images | **Scryfall** by `set`+`collectorNumber` (protocol §1: no client card DB), cached + rate-limited, always backed by a text-frame fallback (§9) | The only external dependency at runtime — and a *soft* one: every card is fully playable as text if Scryfall is down or the identity doesn't resolve. |
| Tests | **vitest** (unit + corpus + replay) and **Playwright** against a real bridge + XMage (the client's live tier, §13) | Mirrors the bridge's tier ladder; the Playwright auto-player is the client-side twin of the bridge's live-tier auto-answering seat. |
| Target platform | **Desktop browsers** (current Chrome/Firefox/Safari); mobile layout is v2 | Friends' night is laptops. Phone *lock/sleep* still works via resume (§5) — it's the layout that's deferred, not the reconnect. |

## 2. Load envelope (from bridge measurements, 2026-07-16..18)

What the client must handle comfortably — all numbers from live games through the bridge:

- Largest observed keyframe **~31 KB** (turn 32, four crowded battlefields); typical patches
  **< 1 KB**; whole game **1–3 MB/seat** before `permessage-deflate` (browsers offer it by
  default, satisfying protocol §3).
- **138–379 prompts per game** at AI pace; humans will be slower. Prompt messages are small.
- Log volume: a few thousand `game.log` lines per game.

Consequence: no virtualization anywhere except (maybe) the log panel; a full re-render on
keyframe is fine; per-card memoized components keyed by `id` absorb patch churn.

## 3. Repo layout

```
client/                              # sibling of bridge/
  package.json  vite.config.ts  tsconfig.json  index.html
  public/cardback.svg                # bundled — face-down cards never hit the network
  src/
    protocol/  protocol.ts           # v1.md schema blocks, verbatim; the normative mirror
               codec.ts              # decode()/encode(), dev-strict, unknown-t policy
               commands.ts           # command builders; id mint + clock injected (testability)
    net/       socket.ts             # WS lifecycle FSM (§5), backoff, visibility handling
               session.ts            # token/identity persistence, hello/welcome, resume
               pending.ts            # command → ack/error tracking, retry, post-resume flush
    stores/    connection.ts  lobby.ts  game.ts  prompt.ts  log.ts   # §4 table
    state/     apply.ts              # fast-json-patch wrapper: base check, resync trigger,
                                     #   dev-mode keyframe verify (§6)
               selectors.ts          # derived: status line, me/opponents, combat lines
    images/    scryfall.ts           # resolve queue, cache, fallback chain (§9)
    ui/        screens/  board/  prompt/  cards/  log/  lobby/
    dev/       recorder.ts           # session JSONL ring + download (§12)
               replay.ts             # feed a recorded session back through codec/stores
  test/                              # vitest: unit, corpus (reads ../docs/protocol/samples)
  e2e/                               # Playwright: live tier (real bridge + XMage)
```

## 4. Stores & data flow

Rule (the client's rendering of bridge §4): **every piece of mutable state has exactly one
owning store, and only the protocol layer writes it.** React components read via selectors and
call command functions; they never mutate stores. Command functions never mutate game state
either — the server echo is the only writer (e.g. chat renders only the `game.log` echo,
protocol §10). The single optimistic bit anywhere is the prompt store's `inflight` flag.
One carve-out (added at C3): `autoMana` has no state echo at all (protocol §9), so the game
store holds the **ack-confirmed** last value the `setAutoMana` action sent — written only
after the bridge acks, defaulting to the server's ON. Known limit: a reload + resume renders
the default again while the server keeps the older setting; revisit if it bites at a table.

| Store | Owns | Written by |
|---|---|---|
| `connection` | socket FSM state, backoff attempt, bumped flag | `net/socket` |
| `session` | token, `userId`, display name, persisted deck text, resume anchor `{gameId, lastSeq}` | `net/session`, lobby acks |
| `lobby` | latest `lobby.state` snapshot | `lobby.state` events |
| `game` | canonical `GameState`, `lastAppliedSeq`, sync mode | keyframe/patch/resync flow (`state/apply`) |
| `prompt` | pending prompt, selection scratch (chosen targets, distribution draft), `inflight` | `game.prompt`/`game.promptDone`, answer submission |
| `log` | seq-keyed ordered entries (ring 500), unread-chat count | `game.log` |

Flow is one-directional and matches the bridge's emit order guarantee (state before prompt,
bridge §7): `socket.onmessage → codec.decode → route to owning store → selectors → React`.
Answers flow back `UI → commands.ts → pending.ts → socket`.

## 5. Connection & session layer

**Socket FSM:** `idle → connecting → helloSent → ready → dropped → (backoff) → connecting …`,
with two terminal-ish states: `bumped` (another tab took the session — show the takeover
screen, reconnect only on explicit user action, §10) and `fatal` (fatal `error` → post-game
or home screen). Backoff 1/2/4/8/15 s capped, ±20 % jitter. `navigator.onLine` and
`visibilitychange` short-circuit the wait: on wake from >30 s hidden, reconnect immediately if
closed, else send `game.resync` (phone-lock reality: the OS may have silently killed the socket).

**Identity & resume** (protocol §4, §14): persist `welcome.token` from fresh sessions; present
it on every `hello`. While in a game, persist the resume anchor `{gameId, lastSeq}` (throttled,
1 s — staleness only costs duplicate backfill lines, which the seq-keyed log store dedupes
anyway). Reconnect sends `hello{token, resume}`; on `welcome{resumed:true}` the keyframe that
follows resets the game store, the re-emitted prompt (same `promptId`) replaces the pending one,
and backfilled log entries merge as history (protocol §14: keyframe seq is the new baseline).
`RESUME_FAILED` → clear the anchor, fall back to fresh hello + recovery join (§10).

**Command pipeline** (`pending.ts`): ids from `crypto.randomUUID()` — protocol §3 requires
uniqueness *across reconnects*, so no counters. Each command registers `{resolve, reject}` and
an 8 s timeout: socket still open → retry once with the **same id** (the bridge's idempotency
LRU replays the recorded reply, protocol §14); socket dropped → park it and flush unacked
commands in order after resume. A retried `game.answer` that lost its moment comes back
`PROMPT_STALE` — swallowed silently (§7): the superseding prompt has already rendered.

## 6. State sync (protocol §7)

`state/apply.ts` owns the keyframe/patch discipline:

- `game.patch`: assert `base === lastAppliedSeq`; on mismatch stop applying, send `game.resync`,
  and ignore further patches until the keyframe arrives (events stay ordered, so this is a
  clean gate, not a race). Patch application failure (fast-json-patch throw) → same path +
  a dev-console error with the failing op.
- `game.state` keyframe: **prod** replaces the tree wholesale; **dev** first deep-equals it
  against the locally-patched tree and logs any divergence — the bridge already sends a
  keyframe every 100 patches (bridge §7), so dev mode gets a free continuous
  zjsonpatch ⇄ fast-json-patch conformance probe on real data.
- `session.hello` supports `stateMode:'keyframes'` (protocol §7's debug escape hatch) behind a
  debug-panel toggle — C1/C2 development runs in this mode before patches land in C3.

## 7. Prompt UX

The FSM invariants (protocol §8) map to UI directly: **at most one pending prompt**, rendered
in a single **prompt dock** (fixed position above the hand); all object affordances (highlights,
toggles, click targets) derive from the pending prompt, never from state. Rules that hold for
every kind:

- Every click/binding captures the `promptId` it rendered with; answers carry it. Late clicks
  are fenced server-side (`PROMPT_STALE`) — the client swallows that error silently.
- Submitting sets `inflight` (dock controls disable, the acted-on object gets a spinner badge)
  until `game.promptDone` or a superseding prompt clears it.
- `game.promptDone` dismisses the dock; `reason:'superseded'` needs no special UI — the next
  prompt is already behind it (bridge emit order).
- An unknown `kind` (impossible within a major, protocol §13 — kinds are frozen) renders a
  visible failure card offering skip/concede via `game.action`: same stance as bridge §8,
  a visible stall beats a silently wrong answer.

| kind | Surface | Answer produced |
|---|---|---|
| `confirm` | Dock: message + two buttons (`yesText`/`noText`, defaults Yes/No) | `{confirm, value}` |
| `priority` | Dock: derived status + **Pass** (primary when nothing else to do). Board: highlight cards with ≥1 non-`mana` action; click → single action fires, multiple → popover menu. `mana`-only actions never highlight and live in the card's long-press/right-click menu — the float-mana lesson (protocol §8) rendered as UI policy | `{object, objectId}` (an ability id) or pass `{confirm, false}` |
| `priority` + `combat` | Dock: "Declare attackers/blockers", **Done** button, **All attack** when `special` present. Board: `candidates` pulse, `declared` get swords/shield badges; click toggles — one round trip each, board re-renders from the re-fired prompt (never from local toggle state). A toggle-in on a multi-defender board is followed by a server-sent `chooseTargets` ("Select defender") — no special casing. Toggle-out is offered but the server may ignore it mid-stack (protocol §8) | toggle `{object}`, done `{confirm, true}`, all-attack `{option, key:'special'}` |
| `chooseTargets` | Board highlight of `candidates`; when `cards` present (objects not in visible state, e.g. discard from hand) a modal grid instead. Click accumulates in selection scratch with `k / min–max` counter; **Submit** sends the whole set (recommended, protocol §8), **Decline** shown when `!required \|\| min === 0`. Progress re-prompts (incremental flow) re-render with server `progress` | `{objects, objectIds}`; decline `{cancel}` |
| `chooseAbility` | Popover anchored to `sourceId`'s card (dock-fallback when off-board): option list | `{object, objectId}` |
| `chooseOption` | Dock: option buttons (≤4) or list; **Decline** iff `required === false` | `{option, key}`; `{cancel}` |
| `choosePile` | Modal: two pile columns (either may be empty), click a pile | `{pile, index}` |
| `payMana` | Dock: remaining cost as mana symbols + mana-pool spend buttons for held mana + **Cancel** iff `canCancel`. Board: highlight `sources`. Caveat (protocol §8): a source click may *not* progress payment — if the re-ask arrives with identical `remaining`, badge the clicked source "can't pay this" | `{object}` / `{mana, color}` / `{cancel}` |
| `chooseAmount` | Dock: stepper clamped to `[min, min(max, 99)]` + free numeric input accepting anything in `[min, max]` (max is `Integer.MAX_VALUE` for X announces). **No cancel control** — the answer is required (protocol §8) | `{number, value}` |
| `distribute` | Modal: one row per `among` entry (label + stepper within per-row bounds, `suggested` prefilled), live Σ vs `min…total` validation; Submit enabled only when valid; Cancel iff `canCancel`. Built from spec + hand-written fixtures — never observed live (protocol §16.1); first live firing gets recorded (§12) | `{distribution, amounts}` |
| `playerRequest` | Modal: `requestKey` as title, one button per option | `{option, key}` |

**Turn controls** (protocol §9 — no prompt required) live in a persistent cluster by the dock:
skip menu (resolve stack / end of turn / next main / my next turn / end step before my turn /
cancel skip) whose active toggle renders from `me.skip` — never from the click (the server
clears skips on its own, and `skip:'stack'` on an empty stack is a server no-op; state is the
only truth) — auto-mana toggle, rollback request (hidden while `rollbackTurnsAllowed` is
false), concede (type-to-confirm modal — it is irreversible). Keyboard: `Space` pass (only while a `priority` prompt without `combat` is
pending), `Enter` primary affirmative, `Esc` cancel/decline, `F4` end of turn, `F6` my next
turn, `A` all-attack when offered. Shortcuts suspend while any text input has focus.

## 8. Board UI

```
┌──────────────────────────────────────────────────────────┬────────────────┐
│  [opp]        [opp]        [opp]     ← seat panels:      │  log / chat    │
│  battlefield  battlefield  battlefield  life, counters,  │  (tabbed,      │
│                                         mana pool, zones │   ring 500)    │
│         stack (bottom→top)  ·  combat arrows             │                │
│──────────────────────────────────────────────────────────│                │
│  my battlefield                                          │                │
│  status line ── prompt dock ── turn controls             │────────────────│
│  my hand (fanned)                        [chat input]    │                │
└──────────────────────────────────────────────────────────┴────────────────┘
```

- **Seat panel** per player: name, life (dead/left/monarch/initiative flags), counters, mana
  pool (only non-zero symbols), library/hand counts, command zone (commander with tax badge
  `2×castCount`), graveyard/exile as face piles opening a browser modal. **Commander damage**
  renders as a small per-opponent matrix on the life total's hover/expand — the data is on the
  *victim* (protocol §6), which is exactly how players ask the question ("how much am I on?").
- **Battlefield**: controller-grouped rows (lands compressed), tapped = 90° rotation,
  `attachments` nest under their host, badges for counters/damage/summoning-sick, morph
  face-down renders the bundled card back (own morphs show their real face per the seat's view —
  privacy is upstream, protocol §6).
- **Stack**: bottom→top column; each item shows its card/source, `text`, and target names
  resolved via selectors. Target *lines* (arrows) are deferred with animation (§16).
- **Combat**: `GameState.combat` groups render as attacker→defender arrows and blocker
  groupings during combat steps.
- **Status line**: derived exactly as protocol §2 prescribes (the bridge dropped XMage's 1,330
  status strings because this is derivable): `turn.step` + active/priority player names, e.g.
  *"Upkeep — waiting for Marta"*; a pending prompt's `message` takes over while it's ours.
- **`revealed` / `lookedAt`** windows: floating panels while present in state (they leave via
  patches, not client dismissal).
- **Log/chat panel**: seq-ordered; `kind` styling (`chat` with speaker, `personal` private-eye
  badge, `error` red, `status` muted); `refs` become hover links to card previews; unread-chat
  badge on the tab. Input posts `chat.send` (client-enforced ≤500 chars, protocol §10) and
  renders only the echo.

## 9. Card rendering & images (Scryfall)

Card identity is `set`+`collectorNumber` (protocol §1); resolution:

1. `scryfall.ts` fetches `https://api.scryfall.com/cards/{set}/{number}` (lowercased set)
   through a queue capped ~8 req/s (Scryfall's courtesy limit), prioritized by visibility:
   hand and commanders first, then battlefield, then piles. The `image_uris` URL is cached
   (memory + `localStorage`) and the `<img>` hits Scryfall's CDN directly, which the browser
   caches — steady-state games make near-zero API calls.
2. Miss → one retry via `cards/named?exact=<name>` (XMage set codes occasionally diverge).
3. Still missing → **text frame**: name, cost, type line, rules text, P/T — all present in
   `Card` (protocol §6), so an unresolved image is cosmetic, never functional. Dev mode logs
   every miss (§12).

Face-down/redacted objects use the bundled card back — never the network. Hover anywhere a
card appears (zones, log refs, stack) opens the enlarged preview with oracle text; the text
frame *is* the preview body when the image is missing. Both faces of DFCs stay an open
question (protocol §16.4) — v1 renders the current face the server sends.

## 10. Screens & flows

- **Home**: display name (persisted), *Create lobby* / *Join with code*; `#/join/<CODE>`
  prefills and focuses join. Below: rejoin affordances for a live resume anchor ("Return to
  game") and the recovery path ("Rejoin as <name>" → `lobby.join{code, displayName}` — the
  lost-token flow, protocol §5/§14 — for the friend whose browser ate localStorage).
  **Seat-identity adoption (C4):** protocol §5 has the re-bound session adopt the *seat's*
  `userId` and abandon the one its fresh `welcome` carried, but the bridge performs that swap
  silently — no message announces it. `net/route` therefore reconciles on every `lobby.state`,
  matching by display name exactly as the bridge did (names are unique within a lobby). Skipping
  this makes a recovered seat invisible to itself in every *later* lobby — `seats.find(s =>
  s.userId === userId)` misses, the ready toggle never enables, and the player can never start
  another game. The game screen hides the bug completely, since it renders from the seat-scoped
  `state.me` and never consults `userId`; it surfaced only in the C4 rematch flow.
- **Lobby**: the code, huge and copyable (+ copy-invite-URL button); seat list from
  `lobby.state` (name, deck validity, `problems[]` per line, ready); deck textarea (`.dck` or
  plain list) submitted via `lobby.deck`, acked diagnostics rendered inline, text persisted
  per protocol §5's note that clients hold the deck text; ready toggle; host additionally
  gets *Start* + *fill empty seats with AI*.
- **Game** → §8. **Post-game**: `game.over` banner (winners, reason) over the final keyframe —
  board stays browsable, chat stays live through the bridge's teardown grace (bridge §6).
- **Rematch** (pure client convention, zero protocol surface): host's *Rematch* button runs
  `lobby.create`, then posts `Rematch → <CODE>` into the game chat; every client
  pattern-matches its own chat rendering and prefills *Join rematch* (auto join + re-submit the
  persisted deck). Exactly the automation bridge §6 anticipated when seat pre-fill was cut.
  **Post-game chat does not actually relay (live-probed 2026-07-18, C4):** XMage 1.4.60 stops
  delivering `CHATMESSAGE` for a game's chat once `GAME_OVER` fires, so a line posted after the
  banner reaches nobody — not even its own sender — even though protocol §10 ("valid … until
  post-game teardown"), protocol §14 ("its chat open" through the grace period) and this
  section all promise otherwise. In-game chat is unaffected. Consequence for v1: the announce
  is **best-effort** (a failed one raises the §11 toast naming the code, so the host knows to
  read it out) and the rematch code is **always typeable** in the post-game banner — the path a
  table at one house uses anyway. The field prefills from chat, so whenever the bridge does
  relay post-game chat the one-click path returns with no client change. Closing the gap is a
  **bridge** fix (fan the line out to the seats' sinks itself instead of relying on XMage's
  echo) and is deliberately left out of C4's client scope.
- **Bumped** (second tab took the token — bridge §10 single-tab rule): full-screen notice with
  *Use here* (reconnect, bumping back). No auto-reconnect loop from this state: two tabs
  auto-bumping each other is a fork bomb made of WebSockets.

## 11. Errors & notices

Non-fatal `error` → toast (auto-dismiss, 5 s) except the silent set: `PROMPT_STALE` (§7) and
per-command errors already rendered in place (deck diagnostics, join failures). `fatal:true` →
modal → home or post-game screen. Bridge-side upstream trouble arrives as `game.log
kind:'status'` lines ("reconnecting to the game server…", bridge §5) — surfaced as a banner
over the board, cleared by the next status line or keyframe. Socket-level reconnects show the
same banner style with attempt count.

## 12. Config, persistence, observability

Config is one compile-time value: the WS URL (`VITE_BRIDGE_WS`, default same-origin `/ws`).
`localStorage` keys, all under `cn.`: `token`, `name`, `deck`, `resume` (anchor, §5),
`imageCache`, `settings` (debug toggles).

- **Session recorder** (`dev/recorder.ts`) — the client-side analog of the bridge's callback
  tap: every decoded inbound message + every outbound command into a ring (last ~2,000),
  downloadable as JSONL from the debug panel; dev builds record unconditionally. A recording
  feeds `dev/replay.ts` to re-drive codec + stores headlessly (fixtures for §13) or to
  reproduce a bug exactly as the wire saw it.
- **Debug panel** (`` ` `` toggle or `?debug`): live message trace, seq/`lastAppliedSeq`,
  patch-vs-keyframe counters, force-resync button, keyframes-mode toggle (next connect),
  recorder download, Scryfall miss list.
- Dev-mode consistency probes, all already described: keyframe deep-equal (§6), unknown-`t`/
  unknown-field warnings (§1), image misses (§9).

## 13. Testing strategy

| Tier | What | How |
|---|---|---|
| Unit (vitest) | codec, patch/resync gate (incl. base-mismatch and mid-resync patch drops), pending/retry/idempotent flush, prompt store transitions (supersede, inflight, stale), selectors (status line, commander-damage matrix), scryfall queue/fallbacks, deck-text persistence | Headless — no React needed anywhere in this tier by construction (§4) |
| Conformance corpus | the mirror image of the bridge's `ProtocolSamplesTest` (corpus README): every server→client sample **decodes** through `codec` into the typed union (dev-strict — unknown fields in a *sample* are a spec bug), every client→server sample is **reproduced** by `commands.ts` builders with pinned id/clock injection | vitest over `../docs/protocol/samples/*.json`; runs in CI with the bridge's suite — a corpus change breaks whichever side didn't follow |
| Replay | recorded live sessions (gzipped JSONL fixtures, from §12's recorder) re-driven through codec + stores | Asserts: zero decode errors, gapless seq, every patch applies, ≤1 pending prompt, final state matches the recorded final keyframe. Includes hand-written sequences for the never-observed-live kinds (`distribute`) and hostile orderings (supersede bursts, resync mid-selection) |
| Live E2E (Playwright) | real bridge + XMage server, real DOM | The **auto-player**: the bridge live tier's policy (play lands, cast each castable once with payMana-cancel bounded, attack with one creature, first-legal dialog answers) driven through visible UI only. Asserts a full game to `game.over`, ≥1 combat declaration through the board, zero unexpected resyncs, and the UI-completeness invariant: **a rendered prompt always exposes ≥1 enabled control** (stuck 60 s = fail). A second scenario runs two browser contexts with mid-game reloads on both, chat, and a rematch — the client-side mirror of `MultiHumanLiveTest` |

## 14. Milestones

Client milestones are **C0–C5** (M-numbers stay reserved for the bridge). Each exit criterion
is demonstrable end-to-end, per the bridge tradition.

| # | Deliverable | Exit criterion |
|---|---|---|
| C0 | Scaffold: Vite/React/TS-strict under `client/`, `protocol.ts` transcribed from v1.md, codec + command builders, corpus mirror test, recorder/replay skeleton | `npm test` green including all 47 corpus samples both directions; `npm run dev` against a local bridge completes hello → welcome with the trace visible in the debug panel |
| C1 | Connection + lobby: socket FSM, token persistence, home/lobby screens, deck upload with inline diagnostics, `#/join` deep link, fillAI start; keyframes mode | Two browsers create/join a lobby on the real bridge, submit decks, host starts with AI fill; both land on a stub game screen with live keyframes rendering as raw state |
| C2 | **First playable game**: board/hand/stack/log rendering, status line, prompt dock with `confirm`/`priority`/`chooseTargets`/`payMana` (the set a real game actually needs — bridge M2 learned cleanup discards force targets), Scryfall images + text-frame fallback | A human plays a full game against 3 AIs **in the browser** to `game.over` — the client-side mirror of bridge M2's criterion |
| C3 | Full vocabulary + patches: all 11 prompt kinds incl. combat declaration UI, patch mode + resync gate, turn controls (`game.action` set), keyboard shortcuts, Playwright auto-player | Auto-player finishes a patch-mode game through the DOM with ≥1 combat declared; no-dead-end-prompt invariant and dev keyframe-verify green over the whole game |
| C4 ✅ | Multi-human resilience: resume UX, chat panel, retry/idempotent flush, recovery join, bumped screen, rematch flow, post-game screen | **Met 2026-07-19** (`e2e/pw/resilience.spec.ts`, 10.2 min): two-browser game, mid-game reload on both sides with the same `promptId` re-rendered, chat both ways + unread badge, bumped round-trip, recovery-join takeover from a cleared-storage context onto the exact pending prompt, rematch into a second completed game. Found and fixed en route: dead-end `chooseTargets` on pile-zone candidates (§7), silent seat-identity loss after a recovery join (§10), and the upstream post-game chat gap (§10) |
| C5 ✅ | Friends'-night readiness: deck-text image warm-up, large-screen layout pass, hover-preview anchoring, pile filter/sort, background-tab title-flash nudge, prod build served by caddy | **The real 4-human night on the deployed host** — the same event as bridge M5's outstanding exit; both docs close together |

**C5 scope revisions (2026-07-19).** Two items shifted against the real table.
The layout pass targets **1080p and 1440p+**, not laptops: every screen at the
table is an external monitor, so the failure mode designed against was an
under-scaled board adrift in whitespace, not cramming — fixed cards sizes were
replaced by a viewport-tracking `--card-unit`. And the nudge is **title flash
only**; the chime was cut, taking the audio asset, the autoplay unlock, and a
settings toggle with it. The layout pass was tuned against a captured turn-25
keyframe and a hand-fattened density ceiling through a temporary `#/layout`
harness, removed at the end of the milestone.

**New at C5: the built bundle is tested.** Every tier through C4 ran against the
Vite dev server, and `window.__night` is `DEV`-gated — so the production bundle,
the thing that actually ships, had never been driven. The auto-player runs against
a `--mode harness` build; `npm run build`, the deploy path, still emits no harness.
(At C5 that was `npm run test:preview` + `client/playwright.preview.config.ts`;
the table client's T5 moved the whole browser tier to the root `e2e/` workspace,
so it is now `npm run preview:harness` here plus `npm run e2e:classic:preview`
at the root — same tier, one config for both clients.)

**Corrected at T5** (2026-07-24): the §6 keyframe-verify probe was gated on
`import.meta.env.DEV`, so it was *off* in exactly the tier built to exercise the
real bundle — and the auto-player asserts `verifies ≥ 1`, which a built bundle
could therefore never satisfy. Both clients now gate the probe (and the
`window.__night` handle) on the same `HARNESS` flag: dev, or a build explicitly
flagged `--mode harness`. `npm run build`, the deploy path, still ships neither.
**Still unverified:** a full preview-tier run has not completed *since* that fix —
the built bundle boots, connects and plays (observed to turn 40), but the run was
cut short. Worth one clean `npm run e2e:classic:preview` before the next deploy,
especially as the same session found the build itself broken (see the table-client
design §14).

## 15. Risks

- **Scryfall identity drift** (XMage set codes / collector numbers vs Scryfall, tokens,
  promos) — fallback chain ends at a fully functional text frame; dev miss-log tells us how
  bad it really is before C5. Worst case is an ugly night, not an unplayable one.
- **fast-json-patch ⇄ zjsonpatch disagreement** — shared with bridge §15, but the client now
  carries live detection: dev keyframe-verify (§6) probes every 100th patch against ground
  truth, and prod self-heals through the same keyframes + resync.
- **Combat UX correctness** — the one place the UI must resist faking state: per-toggle round
  trips (~100–300 ms each over WAN) mean the board renders only server-confirmed `declared`.
  Mitigated by inflight badges; if latency feels bad at C3, that's feedback for a protocol
  batch extension, not client-side guessing.
- **Render performance under patch churn** — low risk at the §2 envelope; guarded by selector
  discipline and per-card memoization. The C3 auto-player run is the de-facto perf soak
  (AI-pace prompts are far faster than humans).
- **Never-observed-live kinds** (`distribute`) — UI built from spec + hand fixtures only;
  recorder captures the first live firing for a real replay fixture (bridge WARNs on its side
  too, bridge §8).
- **Browser sleep beyond teardown grace** — resume handles blips and locks, but a laptop shut
  overnight returns to `RESUME_FAILED`/`UNKNOWN_GAME`; the client must land that gracefully on
  home with an explanation, not a spinner. *(C4: it does — anchor dropped, `info` toast, home.)*
- **Post-game chat is dead upstream** (found at C4, §10) — three documents promise it and
  XMage 1.4.60 does not deliver it. Anything else built on "the chat stays open after the
  banner" (post-game banter, a future spectator recap) inherits the same gap until the bridge
  fans those lines out itself.

## 16. Open questions (two protocol gaps found while writing this — both since closed)

1. **`me` skip flags — RESOLVED (2026-07-18).** `me.skip` added to v1.md §6 (single optional
   mode, not an array: 1.4.60 `PlayerImpl` resets every skip flag before setting any, so at
   most one is active; `PlayerView` carries them as typed fields, no scraping). §7's rule
   follows: render the toggle from state, never from the click.
2. **Rollback gating — RESOLVED (2026-07-18).** `GameState.rollbackTurnsAllowed` added to
   v1.md §6, from `GameView.isRollbackTurnsAllowed()` (a typed field, constant per game).
   The rollback control hides when false — which is real, not theoretical: the bridge
   enables rollback only on all-human tables (AI tables gain nothing from it and XMage's
   per-turn rollback state copy loads the AI server; bridge design §9), so any game with
   AI fill renders without the control.
3. **Semantic move animation** — the deferral rested on a false premise: XMage does *not* mint
   new UUIDs on zone change (protocol §7/§16.5, corrected 2026-07-21). Object continuity is
   already on the wire, and bridge M6 forwards it as an advisory `events?` field. **This client
   stays teleport-rendered by choice** — it ignores the new optional field, exactly as protocol
   §3 requires — because the animated build is a separate client
   (`docs/plans/2026-07-21-table-client-design.md`) and this one is the stable fallback.
4. **Spectators** — `role:'spectator'` is reserved (protocol §16.7); the client's `me`-less
   render path should not be *designed against*, but nothing is built in v1.
5. **DFC both-faces preview** (protocol §16.4) — Scryfall has both faces; the state model
   sends one. Revisit when a real DFC annoys someone at the table.
6. **Mobile layout** — v2, per §1. The protocol needs nothing new; it's purely CSS/layout work.
