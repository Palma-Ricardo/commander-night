# Commander Night

4-player online MTG Commander with full rules enforcement. XMage (self-hosted, version-pinned)
is the authoritative rules server; we build a **JVM bridge** that speaks XMage's native protocol
(Java serialization over JBoss Remoting) upstream and our own JSON/WebSocket **protocol v1**
downstream, plus a TypeScript web client on top. A TS rules engine was evaluated and rejected.

**Read before changing anything:**

- `docs/bridge/design.md` — bridge implementation spec (threading, translation, FSM, milestones)
- `docs/client/design.md` — TS web client spec (stores, prompt UX, Scryfall, milestones C0–C5)
- `docs/protocol/v1.md` — browser ⇄ bridge wire contract (**normative** for message shapes)
- `docs/plans/2026-07-15-xmage-bridge-spike.md` — XMage session API map, spike findings

**Status:** Client C5 engineering done 2026-07-19 — deck-text image warm-up (own deck only:
opponents' lists are hidden info), large-screen layout pass (`--card-unit` scales cards and the
sidebar with the viewport; the table is 1080p/1440p+, so the enemy was whitespace, not cramming),
anchored hover previews, pile filter/sort/Escape, and a background-tab title-flash nudge (the
chime was cut). The production bundle is now exercised for the first time: `npm run test:preview`
drives the auto-player against a `--mode harness` build, and caddy serves `dist/` at `/` with
`/ws` proxied to the bridge (immutable assets, `no-cache` index.html). **Remaining for both
C5 and bridge M5: the real 4-human night on the deployed host.**

C4 detail, still relevant — multi-human resilience, **live-verified** end to end
(`e2e/pw/resilience.spec.ts`, 10.2 min): two browsers, mid-game reload on *both* seats with the
same `promptId` re-rendered after resume, chat both ways with the unread badge, a bumped
round-trip (second tab steals the seat → takeover screen → *Use here* steals it back), a
cleared-storage **recovery join** that reclaims a live seat by name and lands on that exact
pending prompt, game 1 to `game.over` on every seat, then a **rematch into a second completed
game**. `net/pending` is now §5-complete (retry-once-same-id on the 8 s timeout, park on drop,
in-order flush on `welcome`); chat panel, toasts, fatal modal, reconnect/upstream banners, and
the post-game banner all landed. The C3 auto-player loop moved to the shared `e2e/pw/driver.ts`.
Three things this milestone learned the hard way, all now fixed + regression-tested:
(1) **post-game chat does not relay at all** on 1.4.60 — XMage stops delivering `CHATMESSAGE`
once `GAME_OVER` fires, so a line posted after the banner reaches nobody, *not even its sender*,
though protocol §10/§14 and client §10 all promise otherwise (in-game chat is fine). The §10
rematch announce is therefore best-effort (failure → toast naming the code) and the banner's
rematch code is always typeable. **Open bridge-side fix:** fan post-game chat out to the seats'
sinks instead of relying on XMage's echo.
(2) **seat identity after a recovery join** — protocol §5 has the re-bound session adopt the
seat's `userId`, but the bridge swaps it silently, so the client stayed on its stale welcome id
and was invisible to itself in every *later* lobby (ready toggle dead forever). `net/route` now
reconciles on each `lobby.state` by display name. The game screen masks this bug entirely — it
renders from seat-scoped `state.me` and never reads `userId`.
(3) **dead-end `chooseTargets`** — candidates in a pile zone (e.g. "Select a nonland card from
<opponent> graveyard") highlighted nothing and exposed zero enabled controls; the dock now
offers unreachable candidates itself (`selectors.isBoardReachable`).
Auto-player policy notes: pay payMana before cancelling (cancel-first never resolves a spell),
answer the "mana will be lost. Pass anyway?" confirm with Yes, and never re-click a pool
colour/source that failed to shrink `remaining` — payMana re-asks mint a **fresh promptId** each
time, so progress is fingerprinted on the remaining cost, not the prompt id. E2E phases are
sequenced on *events*, never wall-clock: AI-pace games have ended in as little as 3 min.
Bridge status: M5 engineering done 2026-07-18 — commander damage/tax scrape
(`translate/CommanderDamage`, pinned to the 1.4.60 watcher strings, canary WARN on drift,
fields land per protocol §6; watcher lines no longer leak into card text), callback tap
productionized (`CallbackTap`: pre-decompress `.ser` + `.jsonl` index, config `callbackTap`,
always on in the live tier), golden-fixture suite (`GoldenFixtureTest` + `FixtureSelectMain`
curation; 10 live-captured fixtures incl. commander tax/damage and combat declaration; regen
via `-Dgolden.regen=true` on upgrades), conformance corpus audited complete (48 samples, all
asserted; grew by game.state.mulligan.json at client C1), design-§5 seat recovery **live-verified** (`SeatRecoveryLiveTest`: SIGSTOP server
mid-prompt → detect ~6 s → non-fatal answer rejection → restore-session reconnect →
same-promptId re-ground → full game green), and deploy artifacts (`deploy/`: systemd units,
Caddyfile, prod bridge.yaml, runbook; build with `mvn -Pdist -DskipTests package`, launch
smoke-tested). M5's exit criterion — a real 4-human night on the deployed host — is the
remaining human step. M4 context: browser resume, chat, idempotency, recovery join, rematch,
teardown grace (`MultiHumanLiveTest`). M3 context: lost-wakeup race guard (design §5), combat
declaration (§8 `priority.combat`). Milestone table in design.md §14.

## Layout

- `bridge/` — Maven project `night-bridge` (the daemon). Spike/capture tool under
  `bridge/src/spike/java`, activated by `-Pspike`.
- `vendor/` (gitignored) — `xmage-dist/` runnable server + client jars; `mage/` shallow source
  clone for reading XMage internals; `tools/`.
- `docs/` — specs above; `docs/protocol/samples/` is the conformance corpus (bridge tests
  assert it via `ProtocolSamplesTest`; the TS client will assert the mirror direction).

## Commands

```sh
./bridge/install-xmage-jars.sh    # one-time (and after a dist upgrade): installs XMage jars
                                  # into the local Maven repo — they are not on Central
ln -sfn vendor/xmage-dist/xmage/mage-server/db db   # one-time: deck import reads XMage's
                                                    # card db through a hardcoded ./db path
cd bridge && mvn test             # build + unit tests (live tier excluded)

# local XMage server — startServer.sh may lack +x; equivalent. 2048m matches prod (8 GiB host):
(cd vendor/xmage-dist/xmage/mage-server && ../../java/jre1.8.0_201/bin/java -Xmx2048m -jar lib/mage-server-1.4.60.jar)

cd bridge && mvn -Plive test                   # live tier: full game vs 3 AIs through the bridge
cd bridge && mvn -Prun compile exec:exec       # the bridge daemon (repo-root cwd, JDK-26 flags)
cd bridge && mvn -Pharness compile exec:exec   # interactive terminal client (human seat)
cd bridge && mvn -Pspike compile exec:exec     # the spike/fixture-capture tool (repo-root cwd)
```

## Hard constraints

- **XMage version is pinned (1.4.60)** and the bridge must compile against the dist's own jars —
  the server rejects any non-exact `MageVersion` handshake. On upgrade: replace
  `vendor/xmage-dist`, re-run the install script, bump `xmage.version` in `bridge/pom.xml`,
  regenerate golden fixtures.
- Central deps that shadow dist jars (guava, gson, protobuf, jsoup, commons-lang3, reload4j)
  must stay version-identical to the dist's `mage-client/lib`.
- JDK 26 needs `--add-opens=java.base/java.io=ALL-UNNAMED` (+ `java.lang`) and
  `-Djava.awt.headless=true` for the XMage session layer; the `-Pspike` exec config sets them.
- XMage callbacks: always `callback.decompressData()` before `getData()`; read `Choice` payloads
  through typed getters; callbacks arrive on up to 10 threads (bridge serializes per seat pump).
- **Never answer XMage's positional channel < 150 ms after the ask** — 1.4.60 `HumanPlayer` has a
  lost-wakeup race that freezes the whole game (design.md §5). All sends must go through
  `XmageAnswers` (paces automatically; SeatPump nudge-watchdog covers the tail). Never bypass it
  with raw `session.sendPlayer*`.
- Logging is split: our code → slf4j/logback; mage classes → log4j-1.x API via reload4j
  (`log4j.properties`). Never add an `slf4j-reload4j` binding.

## Conventions

- Modern Java (release 25): records + sealed interfaces for protocol types, virtual threads.
- One owning executor per piece of mutable state (design §4) — no shared-state shortcuts.
- Wire-protocol changes happen in `docs/protocol/v1.md` first, then code follows.
