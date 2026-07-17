# Commander Night

4-player online MTG Commander with full rules enforcement. XMage (self-hosted, version-pinned)
is the authoritative rules server; we build a **JVM bridge** that speaks XMage's native protocol
(Java serialization over JBoss Remoting) upstream and our own JSON/WebSocket **protocol v1**
downstream, plus a TypeScript web client on top. A TS rules engine was evaluated and rejected.

**Read before changing anything:**

- `docs/bridge/design.md` — bridge implementation spec (threading, translation, FSM, milestones)
- `docs/protocol/v1.md` — browser ⇄ bridge wire contract (**normative** for message shapes)
- `docs/plans/2026-07-15-xmage-bridge-spike.md` — XMage session API map, spike findings

**Status:** M1 (WS skeleton) done 2026-07-16 — hello/welcome + session-token mint, codec with
BAD_MESSAGE hardening, /healthz, conformance corpus seeded. Next: M2 (first playable seat:
lobby → live game vs AI, ViewTranslator, priority/confirm prompts). Milestone table in
design.md §14.

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
cd bridge && mvn test             # build + unit tests

vendor/xmage-dist/xmage/mage-server/startServer.sh   # local XMage server (bundled JRE 8)
cd bridge && mvn -Pspike compile exec:exec           # run the spike against it (repo-root cwd)
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
- Logging is split: our code → slf4j/logback; mage classes → log4j-1.x API via reload4j
  (`log4j.properties`). Never add an `slf4j-reload4j` binding.

## Conventions

- Modern Java (release 25): records + sealed interfaces for protocol types, virtual threads.
- One owning executor per piece of mutable state (design §4) — no shared-state shortcuts.
- Wire-protocol changes happen in `docs/protocol/v1.md` first, then code follows.
