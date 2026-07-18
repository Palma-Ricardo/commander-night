# Commander Night — Bridge Design (implementation spec)

**Date:** 2026-07-16 · **Status:** DRAFT for review · **Scope:** the bridge process itself —
the JVM daemon that speaks XMage's native protocol upstream and protocol v1 downstream.

Companion documents:

- `docs/protocol/v1.md` — the browser ⇄ bridge wire contract this process implements. Message
  shapes, prompt kinds, and mapping tables are **normative there**; this doc does not restate them.
- `docs/plans/2026-07-15-xmage-bridge-spike.md` — XMage session API map and spike outcome.

## 1. Decisions (settled 2026-07-16)

| Decision | Choice | Basis |
|---|---|---|
| Process model | **Single multiplexed daemon** — one JVM hosts lobby + all games | XMage's own `LoadTest` runs 5 parallel games of `SessionImpl` clients in one JVM; `mage.remote.*` has no mutable static state (verified in source); friends'-night scale is 1–2 concurrent games. Bridge crash loses running games — accepted in v1 (protocol §14). |
| Runtime | **System JDK 26** with `--add-opens=java.base/java.io=ALL-UNNAMED` (add `java.lang` too as cheap insurance) | Verified live 2026-07-16: full connect / version handshake / createTable / seat 4 players / startMatch against the 1.4.60 server. Without the flag, JBoss Remoting dies in `JavaSerializationManager` reflecting into `ObjectOutputStream.clear()`. Only handshake-depth verified — M0 includes a full-game soak. Fallback: dist's bundled JRE 8 (spike-proven) with Java-8-era libs. |
| Language | **Modern Java** — records + sealed interfaces for protocol types, virtual threads for pumps | One language across bridge and the XMage source we read; no new toolchain. |
| Build | **Maven** (system install), XMage dist jars via `install-file` into the local repo, version-pinned 1.4.60 | Compiling against the dist's own jars is what guarantees the exact-`MageVersion` handshake (spike finding). |
| HTTP/WS server | **Javalin 6** (embedded Jetty 11) | Minimal code for WS + the few HTTP endpoints we need; Jetty negotiates `permessage-deflate` when the client offers it (protocol §3 requires it enabled). |
| JSON | **Jackson** (`databind`) for protocol messages; `JsonNode` for the state tree | The spike used Gson because the dist ships it; the real bridge picks its own stack. Jackson is required by zjsonpatch anyway. |
| Diffing | **zjsonpatch** (`com.flipkart.zjsonpatch`), emitting `add`/`remove`/`replace` only (MOVE/COPY disabled via `DiffFlags`) | LCS-based array diffs keep patches small (protocol §7 sizes). Restricting ops keeps us trivially compatible with the client's `fast-json-patch` and keeps zone-change animation heuristics simple (§7). |
| Untimed tables | `MatchOptions.matchTimeLimit` **defaults to `MatchTimeLimit.NONE`** (verified in source) | Closes protocol §16.8 — all 21 spike games were already untimed; the bridge simply never sets a limit. No priority-timeout handling needed in v1. |

## 2. Topology & deployment

```
browser ── wss:// ──► reverse proxy (caddy, TLS) ── ws://127.0.0.1:8484 ──► night-bridge (JVM)
                                                                               │ JBoss Remoting /
                                                                               │ Java serialization
                                                                               ▼
                                                                    xmage server :17171 (JVM, JRE 8)
                                                                    bound to 127.0.0.1 only
```

- Both JVMs on one host, two systemd units (`xmage-server.service`, `night-bridge.service`,
  `After=`/`Requires=` ordering) — committed under `deploy/` with the Caddyfile, production
  config, and install/ops runbook (M5). The bridge **does not manage** the XMage server
  process; it connects to a configured `host:port` and retries with backoff until it appears.
- Only the reverse proxy is publicly reachable. XMage's port stays loopback-only — the bridge is
  the sole client, which is also our auth boundary (XMage's own accounts stay disabled/unused;
  bridge usernames like `seat_<code>_<n>` are internal).
- One XMage client session **per human seat** (protocol §2 — privacy is inherited from the
  server's per-seat filtering). A 4-human game = 4 `SessionImpl`s in the bridge; AI seats are
  server-side and need no session.

## 3. Repo & module layout

```
bridge/
  pom.xml                          # jar: night-bridge; deps: xmage jars (pinned), javalin,
                                   # jackson, zjsonpatch, slf4j+logback; junit5 for tests
  install-xmage-jars.sh            # mvn install:install-file for the dist's client-lib jars
  src/main/java/night/bridge/
    Main.java                      # config load, wiring, lifecycle, shutdown hooks
    config/    Config.java         # record, loaded from YAML (§11)
    proto/     …                   # protocol v1 message records (sealed interface Msg,
                                   #   @JsonTypeInfo on "t"), ErrorCode enum — mirrors v1.md
    net/       WsEndpoint.java     # Javalin WS handler: framing, hello gate, per-conn send queue
               Codec.java          # Jackson (de)serialization + BAD_MESSAGE mapping
    lobby/     LobbyService.java   # codes → lobbies, seat binding, ready/start state machine
               DeckParser.java     # .dck + plain-list formats; diagnostics per line
               CardIndex.java      # name → (set, collectorNumber), generated resource
    xmage/     SeatSession.java    # implements MageClient; one per human seat
               XmageAnswers.java   # typed wrappers over session.sendPlayer* (+ tap logging)
               TableRecipe.java    # createTable/joinTable/startMatch per spike recipe
    game/      GameCoordinator.java# per game: seats, lifecycle, game.over
               SeatPump.java       # the seat's single-thread executor + ownership boundary
               PromptFsm.java      # pending prompt, promptId fencing, compound answers (§8)
    translate/ ViewTranslator.java # GameView → GameState (trim rules of protocol §6)
               PromptTranslator.java  # callback → Prompt kind (protocol §15 table)
               LogTranslator.java  # CHATMESSAGE/INFORM → game.log; HTML strip; refs extraction
               CommanderDamage.java   # CommanderInfoWatcher info-text scrape (§7 here)
    sync/      StateStore.java     # canonical trimmed JsonNode per seat + seq counter
               Differ.java         # zjsonpatch wrapper, empty-diff suppression
               KeyframePolicy.java # start / resync / reconnect / every-100-patches
  src/main/resources/cards-index.tsv   # generated: card name → set/number (§9)
  src/test/java/…                  # §13
  src/test/resources/fixtures/     # Java-serialized callbacks + golden JSON outputs
  src/spike/java/night/spike/      # SpikeMain moves here unchanged (kept runnable; build
                                   # profile `-Pspike`) — it is the capture tool for fixtures
```

The `bridge/build.sh` + `run-spike.sh` scripts are retired once the Maven build reproduces them
(M0 exit criterion).

## 4. Threading model

Rule: **every piece of mutable state has exactly one owning executor; nothing else touches it.**

| Executor | Cardinality | Owns |
|---|---|---|
| **Seat pump** (single-thread, virtual) | one per human seat | canonical `GameState`, seq counter, `PromptFsm`, log ring buffer, XMage answer sends |
| **Lobby executor** (single-thread) | one | all lobbies, seat↔connection binding, table recipes |
| **Scheduler** (`ScheduledExecutorService`) | one, shared | `session.ping()` every 10 s per XMage session (spike cadence), XMage-connect retry. (Seat-recovery backoff and the post-game teardown grace run on short-lived per-seat/per-game virtual threads instead — v1 simplicity; both re-enter their owning executor and their targets are idempotent/`closing`-guarded, so a late timer is harmless) |
| Jetty/Javalin threads | pool | nothing of ours — they only *enqueue* |

- XMage callbacks arrive on up to 10 threads per session (spike finding): `onCallback` does
  `decompressData()` + timestamps, then enqueues onto the seat pump. All translation, diffing,
  seq assignment, and prompt logic run on the pump — total ordering per seat for free.
- Client → server WS messages: decoded on the Jetty thread, then routed — `lobby.*` to the lobby
  executor, `game.*`/`chat.*` to the target seat pump. Unknown `gameId` → `UNKNOWN_GAME`.
- Server → client sends: each WS connection has a bounded send queue (default 256 msgs) drained
  by async Jetty writes. Overflow (pathologically slow client) → close the socket; the client
  reconnects into the resume flow, which is cheap by design (keyframe + prompt + log tail).
- No watchdog *auto-pass* in the real bridge (the spike's 8 s nudge was a greedy-bot hack).
  Untimed tables mean XMage waits for humans indefinitely; that is the desired behavior. The
  M3 lost-wakeup *nudge* watchdog (§5) is different in kind: it re-pokes XMage's answer
  channel with a rejected sentinel, never answers on the player's behalf.

## 5. XMage session layer

Per-seat `SeatSession implements MageClient`, connected via `new SessionImpl(this)` +
`connectStart(Connection)`. Facts the implementation must honor (all spike-verified):

- `callback.decompressData()` before every `getData()`.
- Read prompt payloads through **typed getters** (`getChoices()`, `getKeyChoices()`) — `Choice`/
  `ChoiceImpl` does not survive reflective serialization (protocol §15 caveat).
- `-Djava.awt.headless=true` (SessionImpl uses SwingWorker internally).
- Keepalive `ping()` on the scheduler; JBoss lease handles transport-level liveness.
- `GameView.canPlayObjects` is the playable list; mana abilities are *not* priority actions
  (the floating-mana ask-loop lesson — encoded in `PromptTranslator`, protocol §8 `priority`).
- **The lost-wakeup race** (discovered M3, 2026-07-17). 1.4.60's `HumanPlayer.waitForResponse`
  sets `responseOpenedForAnswer = true` *before* entering a predicate-less `response.wait()`;
  an answer whose `notifyAll` lands in that gap is lost, and the game thread waits forever —
  the whole game freezes until the seat disconnects. Jstack-verified live
  (`HumanPlayer.java:337`). Crucially, **arrival-time pacing cannot close the race**: every
  `setResponse*` first parks in `waitResponseOpen()` — a 100 ms spin-poll on that non-volatile
  flag — so an answer reaching the server while the flag is still closed is *delivered on the
  flag edge*, racing the game thread's monitor entry no matter how late it was sent (live-
  verified: 150 ms pacing alone still wedged 6 of 8 games). Human clients rarely lose because
  their answers arrive long after the flag opens, with the game thread safely parked — the
  spike's 8 s auto-pass "hack" never wedged because it was unknowingly re-notifying. The
  guard is therefore two-part: `XmageAnswers` paces every positional send ≥150 ms after the
  ask (human timing profile — shrinks exposure), and the `SeatPump` watchdog is the actual
  guarantee: 6 s with *no new ask* after an answer → nudge the channel with the sentinel
  `new UUID(0,0)` — every ask kind validates-and-rejects it by re-firing the ask
  (source-verified), so a false positive (AI thinking long) is harmless, while a nudge fired
  into a parked `wait()` cannot itself be edge-lost. State updates and chat are *not* proof
  of life (they flow from other seats' activity while the game thread stays wedged) — only a
  fresh ask or game-over stands the watchdog down. It nudges with exponential backoff (6 s
  doubling to a 60 s cap) indefinitely and never declares the seat lost: ask-silence is not
  evidence of loss (AIs think 30 s+ on big boards — live-observed at T45), and transport
  loss is the session layer's job to detect.

**Seat recovery (best-effort, v1 — implemented M4, live-verified M5):** if a seat's XMage
session drops mid-game (`MageClient.disconnected`, filtered for our own connectStop/connectStart
noise), the browser gets `game.log kind:status` ("reconnecting to the game server…"), positional
answers are rejected (`UPSTREAM_ERROR` non-fatal) while a virtual thread retries
`SeatSession.reconnect()` with backoff (2/4/8/15/15 s). Reconnect uses XMage's restore-session
handshake — `setRestoreSessionId(previous session id)` before `connectStart` — which the server
matches in `Session.validateUser` to flag a reconnection and re-attach the user's active tables
(`User.onReconnect`, source-verified 1.4.60); the pump then re-runs `joinGame` + chat join.
Success → status line, fresh keyframe, pending-prompt re-emit (XMage usually also re-fires the
current ask, which supersedes cleanly). 5 failures → `error UPSTREAM_ERROR fatal:true` to that
seat, game continues for the others. Bridge process death still loses the game (protocol §14);
process-level re-attach is v2. Live-verified 2026-07-18 (`SeatRecoveryLiveTest`, live tier):
SIGSTOP the server mid-game with a prompt pending → the 10 s session ping trips detection in
~6 s → status line, probe answer rejected non-fatally → SIGCONT → restore-session reconnect in
one attempt (~3 s) → keyframe + same-promptId re-emit on the same socket, then a full game to
game.over with all protocol invariants green.

## 6. Game coordinator

`GameCoordinator` is thin on purpose — almost everything is per-seat:

- Holds the seat list, gameId, table ids; transitions lobby → game on `START_GAME` (each seat's
  session calls `joinGame`, joins game chat via `getGameChatId`).
- Aggregates `GAME_OVER` + `END_GAME_INFO` (arrives per seat; first one wins) → each pump emits
  final keyframe + `game.over` (protocol §11). Sockets stay open for post-game chat.
- Rematch = a fresh lobby (M4 decision: a started lobby stops holding its members, so players
  simply create/join again — protocol §5). Seat pre-fill was cut: v1 has no `lobby.leave`, so a
  pre-filled seat whose player moved on would block `lobby.start` forever. Revisit with the TS
  client (a "Rematch" button can automate create + join + re-submit deck).
- Post-game teardown: when every human seat has seen game over, the coordinator schedules
  release after a grace period (config `postGameGraceSecs`, default 900) — XMage sessions
  released, game unregistered. Until then the game chat stays relayed and resume replays the
  final keyframe + `game.over`.

## 7. Translation pipeline (per seat, on the pump)

```
ClientCallback
  → PromptTranslator?          — is this one of the 11 dialog callbacks? (protocol §15 table)
  → embedded GameView?         — GAME_UPDATE*, and the view inside SELECT/TARGET/PLAY_MANA/…
      → ViewTranslator.trim    — protocol §6 rules: maps→arrays, render hints dropped,
                                 interaction hints stripped (they live in the prompt),
                                 commander fields structured (scrape below)
      → StateStore + Differ    — RFC 6902 vs previous trimmed tree; empty diff → emit nothing
      → KeyframePolicy         — patch, or keyframe at start/resync/reconnect/every 100 patches
  → emit order: game.patch (or keyframe) FIRST, then game.prompt
```

The ordering rule matters: prompt `candidates` must reference objects already present in the
client's state. XMage bundles the view and the question in one callback; we split them into two
protocol events with state first.

**Commander damage / tax scrape** (`CommanderDamage`; implemented M5): regex over
`CommanderInfoWatcher.addCardInfoToCommander` HTML in the commander's rules lines, pinned to
1.4.60 with unit + golden-fixture tests (protocol §16.3). The watcher's info lines surface
wherever the commander currently is, so **every** card translated in a snapshot runs through
the scrape: the lines are lifted out of the trimmed text (they leaked as stray "Commander"
lines pre-M5), cast counts attach to the command-zone object they were scraped from, and
damage entries attach to the *damaged* player's `commanderDamage` in a second pass (the line
lives on the attacker; the protocol field on the victim). Scrape failure → canary WARN + omit
the field, never fail translation. If 1.4.61+ changes the text, fixtures catch it at upgrade
time.

**Log pipeline** (`LogTranslator`): `CHATMESSAGE` per protocol §10 — drop `color:ORANGE`
structure announcements, strip HTML, extract `object_id='…'` attributes into `refs`,
`GAME_INFORM_PERSONAL` → `kind:'personal'`. Every entry lands in the seat's ring buffer
(capacity 200) for resume backfill.

## 8. Prompt FSM

State per seat: `idle | pending(prompt) | replaying(compound)`. Invariants from protocol §8:
at most one pending prompt; bridge-monotonic `promptId`; answers fenced by `promptId`
(`PROMPT_STALE` otherwise); shape/candidate/min-max validation (`INVALID_ANSWER`).

- **New dialog callback while `pending`** → emit `game.promptDone(reason:'superseded')`, then the
  new prompt. XMage's answer channel is positional, so the FSM must never let a stale client
  answer through after the server has moved on.
- **Compound answers** (`{type:'objects'}`, multi-target): the client submits whole; XMage
  collects one at a time. On receipt the FSM enters `replaying`: send first UUID, then treat the
  *next* target-flavored callback as continuation — match on same message key with advanced
  progress (`selected k of n` parse, same one the `progress` field uses) — consuming it
  internally (state updates still flow!) and sending the next UUID. When all sent: XMage either
  proceeds (done) or asks once more → reply done-boolean (`true`). Any non-matching callback, or
  matching with **unadvanced** progress (a pick was rejected): abort the replay, surface the
  callback as a fresh prompt. The client sees `promptDone(superseded)` + a new prompt with
  current progress — ugly but correct, and only reachable when XMage rejects a candidate it
  itself offered.
- **`payMana` is not compound**: each `GAME_PLAY_MANA` round-trip is its own prompt (remaining
  cost changes every time). One click (`object` / `mana` / `cancel`) per prompt.
- **Combat declaration is per-toggle** (protocol §8): a `GAME_SELECT` whose options carry
  `possibleAttackers`/`possibleBlockers` becomes `priority` + `combat` — XMage re-fires the ask
  after every toggle, so each toggle is its own prompt round trip (a toggle-in on a
  multi-defender board is followed by a normal "Select defender" `chooseTargets`). Done
  declaring = boolean of either value (`HumanPlayer` ignores the value); "All attack" =
  `sendPlayerString("special")`. Never compound: these asks carry no `selected k of n` progress
  for the replay matcher to key on, so `{type:'objects'}` is rejected there.
- **Provisional kinds** (`distribute` from `GET_MULTI_AMOUNT`, `PLAY_XMANA` routing): mapped and
  implemented from source per protocol §15/§16 — 21 coverage games never fired them (structural:
  greedy bot always fills max targets, so distribution rides `chooseTargets`; X rides
  `PLAY_MANA`). Log at WARN + include in the callback tap when first seen live.
- Unknown/unmapped interactive callback: do **not** auto-answer (that was spike behavior). Emit
  `error UPSTREAM_ERROR` (non-fatal) + `game.log kind:error`, and log loudly. The seat can skip
  or concede via `game.action`; better a visible stall than a silently wrong answer.

## 9. Lobby service

- Lobby code: 6 chars from an unambiguous alphabet (no 0/O/1/I), created by `lobby.create`;
  lobbies expire after 4 h idle. The code is the only shared secret (§10), hence the entropy
  and per-connection rate limiting on join attempts.
- `lobby.join` binds `{token, displayName}` → seat. Same token rejoining re-binds to its seat
  (pre-game reconnect). After the game has started, a join whose `displayName` matches a seated
  player (case-insensitive) re-binds that seat to the caller's token — the lost-token recovery
  path (§10). Host = creator (`hostUserId`).
- **Decks** (`lobby.deck`): two formats per protocol §5. `.dck` parses as in the spike
  (`[SET:NUM] Name`, `SB:` = commander). Plain list ("1 Card Name") resolves names through
  `cards-index.tsv` — generated offline by a script that scrapes `vendor/mage` `Mage.Sets`
  sources for `(name, set, collectorNumber)` (the technique that built the coverage deck),
  preferring the newest printing. Unresolvable lines → per-line diagnostics in the ack. Bridge
  pre-validates main+SB = 100 and commander-in-sideboard for friendlier errors than XMage's
  joinTable rejection.
- **AI fill**: host may fill empty seats with `COMPUTER_MAD` + a sample deck (dev/testing and
  odd-numbered nights; the spike recipe unchanged).
- `lobby.start`: runs `TableRecipe` — `getMainRoomId` → `createTable(MatchOptions)` (game type
  `Commander Free For All`, deck type `Variant Magic - Commander`, range ALL, attack MULTIPLE,
  `winsNeeded 1`, time limit untouched = `NONE`, `rollbackTurnsAllowed` = **true iff no AI
  seats** — the MatchOptions default is `false`, which had left §9 `requestRollback` dead
  until 2026-07-18. All-human tables get the undo; AI tables stay at the
  milestone-validated `false` because rollback buys them nothing (auto-players never roll
  back) while its per-turn `state.copy()` loads the AI-simulation server — suspected,
  unproven, of shortening AI games in 2026-07-18 live runs. Protocol §6
  `rollbackTurnsAllowed` tells the client which one it got) → `joinTable` per AI → per human seat (each
  through its own `SeatSession`) → `startMatch`. Any step failing → `error LOBBY_STATE` with the
  step name; lobby stays joinable.

## 10. Browser sessions, resume, idempotency

- **Auth v1 — the lobby code is the only shared secret** (resolves protocol §16.6). Perimeter =
  VPS address + generated code; no accounts, no pre-shared tokens, nothing to distribute but the
  code itself. Codes are 6 chars (§9) and join attempts are rate-limited per connection, so a
  code isn't guessable within a lobby's lifetime even if the endpoint is discovered.
- **Identity = bridge-minted session token.** A `hello` without a token is a fresh session: the
  bridge mints a random 128-bit token and returns it as `welcome.token` (optional field, additive
  per protocol §13). The client persists it (localStorage) and presents it on every later
  `hello`. The token identifies a *session/seat binding*, not a person — it is never shown to or
  typed by anyone. An unknown token without `resume` is treated as a fresh session (bridge
  restarted, storage stale — not an error); unknown token *with* `resume` → `RESUME_FAILED` and
  the client falls back to a fresh hello + recovery join.
- Connection registry: `token → {seat bindings, live WS}`. A second connection with the same
  token bumps the first (single-tab rule; the bumped socket gets `error` + close).
- **Recovery (lost token / new device):** `lobby.join{code, displayName}` on a running game
  re-binds the matching seat to the caller's fresh token (§9), bumps the old socket if any, and
  replays the resume sequence below. Anyone holding the code is inside the trust boundary by
  definition, so name-claim griefing is a friends problem, not a security one.
- **Resume** (protocol §14): `hello{resume}` → `welcome{resumed:true}` → fresh keyframe → pending
  prompt re-emit (same `promptId`!) → log backfill from the ring buffer (`seq > lastSeq`, cap 50).
- **Command idempotency:** per-token LRU (size 64) of recent command ids → duplicate re-acks
  without re-execution. Covers client retry after a lost ack.

## 11. Configuration (single YAML file)

```yaml
bind: 127.0.0.1:8484          # behind caddy; caddy owns TLS + the public name
xmage: { host: 127.0.0.1, port: 17171 }
keyframeEvery: 100            # patches (protocol §7)
logBackfill: { buffer: 200, send: 50 }
callbackTap: false            # §12 — per-game JSONL capture like the spike logs
postGameGraceSecs: 900        # §6 — post-game chat/resume window before teardown
sampleDecksDir: vendor/xmage-dist/xmage/mage-client/sample-decks/Commander
```

JVM flags live in the systemd unit: `--add-opens=java.base/java.io=ALL-UNNAMED
--add-opens=java.base/java.lang=ALL-UNNAMED -Djava.awt.headless=true`.

## 12. Observability

- slf4j + logback; per-seat MDC (`game`, `seat`) so one game's four pumps interleave readably.
- **Callback tap** (config flag; implemented M5): per seat per game under `logs/tap/`, two
  files — `<label>.ser` (every `ClientCallback` Java-serialized **pre-decompression**, i.e.
  byte-faithful wire objects: the golden-fixture source, §13) and `<label>.jsonl` (an index
  line per callback: ordinal, ts, method). Curate fixtures from a capture with
  `FixtureSelectMain` (test tree). The spike's full-JSON dump stays in the spike tool.
- `GET /healthz`: bridge up + XMage connection state.
- End-of-game INFO summary: callbacks seen, patches/keyframes emitted, bytes pre/post deflate,
  prompts by kind, translation warnings. (The numbers that validate protocol §2/§7 budgets.)

## 13. Testing strategy

| Tier | What | How |
|---|---|---|
| Unit | translators, differ+keyframe policy, prompt FSM, deck parser, HTML strip, commander-damage regex | Plain JUnit; FSM driven by scripted callback sequences against a mocked `mage.remote.Session` (it's an interface), asserting the exact `sendPlayer*` calls |
| Golden fixtures | `ViewTranslator`/`PromptTranslator` on real payloads | Capture **Java-serialized** `ClientCallback`s via the tap during live games (Gson JSON can't round-trip back into view objects — `Choice` proved that); deserialize in tests against the same pinned jars, assert golden JSON outputs. Implemented M5: `GoldenFixtureTest` over `src/test/resources/fixtures/` (10 fixtures incl. commander tax + damage, combat declaration), goldens are wire-message arrays in emit order. Regenerate on XMage upgrade (`mvn test -Dtest=GoldenFixtureTest -Dgolden.regen=true`) → diffs show exactly what the upgrade changed |
| Live integration | whole bridge vs local server | JUnit tag `live`: boot bridge, JDK 26's built-in `java.net.http.WebSocket` as test client, 1 human + 3 AI game (spike recipe), auto-answering client. Asserts protocol invariants over a full game: seq gapless, every patch applies cleanly onto the running state (apply + periodically compare against a forced keyframe), ≤1 pending prompt, every prompt answered, clean `game.over` |
| Conformance corpus | bridge ⇄ TS client agreement | Committed JSON samples per message type under `docs/protocol/samples/` — bridge tests assert it *produces/accepts* them, the future TS client tests assert it *parses/produces* them. The two codebases never drift silently |

The live tier doubles as the JDK-26 soak (§1 runtime risk) and as the M2+ regression suite —
what the spike was, promoted to CI.

## 14. Milestones

| # | Deliverable | Exit criterion |
|---|---|---|
| M0 | Maven scaffold: pom, jar-install script, spike relocated, logback, config loader | `mvn test` green; spike runs via `-Pspike` under JDK 26; full-game soak passes (runtime risk retired) |
| M1 | WS skeleton: Javalin endpoint, codec, hello/welcome, session-token mint, healthz | `websocat` can hello → welcome; bad input → `BAD_MESSAGE`, never a crash |
| M2 | **First playable seat**: lobby (1 human + AI fill) → live game, ViewTranslator + keyframes-only mode (`stateMode:'keyframes'`), `priority`/`confirm` prompts + answers, log pipeline | A human plays a real game against 3 AIs from a raw-WS harness; **TS client development can start here** |
| | *M2 done 2026-07-16.* Shipped beyond the letter: `chooseTargets` (one pick per round-trip, §8-style like `payMana`) and `payMana` prompts — an auto-passing seat hits cleanup discards (GAME_TARGET) every game, so priority/confirm alone can't finish the exit criterion. Still M3: remaining 6 prompt kinds, compound `objects` replay, patches/resync, `game.action`. `lobby.start` gained `fillAI` (protocol §5); interactive harness = `mvn -Pharness compile exec:exec`; live tier = `mvn -Plive test` | |
| M3 | Full prompt vocabulary + FSM (all 11 kinds, compound replay), patches + resync, `game.action` set | Live-integration invariants green over a full game; patch-mode wire size within protocol §7 budget (≈1–3 MB/seat/game) |
| | *M3 done 2026-07-17.* All ten live prompt kinds + `playerRequest` (park/revive), compound `objects` replay with hostile-script unit tier, RFC 6902 patches (add/remove/replace only) + `game.resync`, `game.action` set (concede/skip/rollback/autoMana/triggerOrder), 17 new corpus samples. Validation: 8/8 full games vs 3 AIs, 138–259 prompts each, 0.8–1.9 MB/seat, keyframes < patches/10. The tier surfaced and fixed the **1.4.60 lost-wakeup race** (§5): answer pacing + ask-keyed nudge watchdog with backoff, live-proven recovering 3–21 wedges/game. Two non-bridge stall classes diagnosed en route: degenerate-board AI think-timeout chains (server-side; test event timeout now 300 s) and a test-harness race that dropped prompts pulled mid-await (stash fix) | |
| | *Post-M3 gap fix 2026-07-17.* Combat declaration (declare attackers/blockers) never reached the wire: `GAME_SELECT` with `possibleAttackers`/`possibleBlockers` was translated as a bare priority prompt (candidates dropped), the FSM rejected the done-boolean, and protocol v1 had no combat vocabulary at all. 8/8 validation games missed it twice over: the pacifist auto-player never controlled a creature, and XMage skips the ask entirely for a creatureless seat (`Combat.selectAttackers` first-time gate on `getAvailableAttackers`; `selectBlockers` early-returns on zero possible blockers) — and even when the ask fires, a pass (`confirm:false`) is a legal "declare nothing". Now specced (protocol §8 `combat`, §15 rows) and wired through translator/FSM/harness; the live auto-player plays lands, casts (each castable tried once, payMana-cancel bounded), and attacks with one creature per combat, so the toggle → defender-pick → done round-trip is a permanent live invariant (`combatPrompts >= 1` asserted) | |
| M4 | Multi-human: seat binding, resume/reconnect, idempotency, chat send, `game.over`/rematch | Two-browser game with mid-game refreshes on both sides |
| | *M4 done 2026-07-18.* Browser resume (`hello{token,resume}` → `welcome{resumed}` → keyframe → pending prompt under its **original promptId** → log-tail backfill), `chat.send`, per-session idempotency (LRU 64 at the WS routing gate, replaying the recorded reply; §3 gained the ids-unique-across-reconnects rule it implies), lost-token recovery join (registry *adopt*: the caller's session takes over the seat's userId, the old token is retired, the old socket bumped), rematch = started lobbies release their members, post-game teardown after `postGameGraceSecs` (lost seats count toward it, so an abandoned seat can't leak the game). §5 seat recovery implemented via XMage's restore-session handshake (live verification on the M5 list). Harness learned session persistence/`reconnect`/`chat`. Validated: `MultiHumanLiveTest` — 2 humans + 2 AIs, full game, mid-prompt hard refresh on **both** seats (same-promptId re-emit asserted), chat + verbatim-duplicate probe (two acks, one execution), mid-game recovery handover to a fresh session, post-game resume replay, rematch lobby, teardown expiry (`UNKNOWN_GAME`/`RESUME_FAILED`). 151-test unit tier; M3 solo game stays green (379/379 prompts, 2.2 MB/seat) | |
| M5 | Commander damage scrape, golden-fixture suite, conformance corpus, systemd/caddy deploy docs | A real 4-human friends' night on the deployed host |
| | *M5 engineering done 2026-07-18.* Commander damage/tax scrape (§7): pinned regexes over the watcher's info lines with a drift-canary WARN, castCount on command-zone objects, damage on the *victim's* `commanderDamage` (sorted for patch stability), watcher lines stripped from all card text (they had been leaking). Callback tap productionized (§12): pre-decompression `.ser` + `.jsonl` index per seat, on by default in the live tier. Golden tier realized (§13): `FixtureSelectMain` curation + `GoldenFixtureTest` over 10 live-captured fixtures — incl. real `castCount:1`, a real 4-damage commander entry, and the combat-declaration ask — goldens are wire-message arrays; regen flow for upgrades. Corpus audited complete (47 samples, every type/kind/variant asserted; added hello-keyframes + chat-echo). §5 seat recovery live-verified (SIGSTOP test above). `deploy/`: both systemd units, Caddyfile, prod config, runbook; `-Pdist` package profile, launch command smoke-tested. Unit tier 168 tests. **Remaining for exit: the actual 4-human night on the deployed host** | |

## 15. Risks

- **JDK 26 × JBoss Remoting beyond the handshake** — only connect-depth verified. M0 soak
  retires it; fallback is bundled JRE 8 + Jetty-9-era stack (spike-proven, uglier deps).
- **zjsonpatch ⇄ fast-json-patch disagreement** — mitigated by add/remove/replace-only diffs +
  the conformance corpus + live-tier apply-and-compare.
- **Compound-target replay edge cases** — the one place the FSM interprets XMage's positional
  channel. Mitigations: progress-parse continuation matching, abort-to-fresh-prompt on any
  surprise, FSM unit tier with hostile scripted sequences.
- **Card-name index drift** (plain-list decks) — index is generated from the *pinned* XMage
  version's sets; regenerate on upgrade. `.dck` path has no such dependency.
- **Commander-damage scrape brittleness** — fixture-pinned; failure degrades to a missing field,
  and protocol §16.3 lists fallbacks (combat-log derivation; server patch as last resort).
- **Unobserved-live prompt kinds** (`distribute`, `PLAY_XMANA`) — implemented from source,
  flagged at WARN on first live firing; tap capture will confirm shapes then.
