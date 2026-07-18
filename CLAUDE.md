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

**Status:** M5 engineering done 2026-07-18 — commander damage/tax scrape
(`translate/CommanderDamage`, pinned to the 1.4.60 watcher strings, canary WARN on drift,
fields land per protocol §6; watcher lines no longer leak into card text), callback tap
productionized (`CallbackTap`: pre-decompress `.ser` + `.jsonl` index, config `callbackTap`,
always on in the live tier), golden-fixture suite (`GoldenFixtureTest` + `FixtureSelectMain`
curation; 10 live-captured fixtures incl. commander tax/damage and combat declaration; regen
via `-Dgolden.regen=true` on upgrades), conformance corpus audited complete (47 samples, all
asserted), design-§5 seat recovery **live-verified** (`SeatRecoveryLiveTest`: SIGSTOP server
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
cd bridge && mvn test             # build + unit tests (live tier excluded)

# local XMage server — startServer.sh may lack +x; equivalent:
(cd vendor/xmage-dist/xmage/mage-server && ../../java/jre1.8.0_201/bin/java -Xmx1024m -jar lib/mage-server-1.4.60.jar)

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
