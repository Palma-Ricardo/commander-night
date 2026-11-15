# Commander Night

4-player online MTG Commander with full rules enforcement. XMage (self-hosted, version-pinned)
is the authoritative rules server; we build a **JVM bridge** that speaks XMage's native protocol
(Java serialization over JBoss Remoting) upstream and our own JSON/WebSocket **protocol v1**
downstream, plus a TypeScript web client on top. A TS rules engine was evaluated and rejected.

**Read before changing anything:**

- `docs/bridge/design.md` — bridge implementation spec (threading, translation, FSM, milestones)
- `docs/client/design.md` — TS web client spec (stores, prompt UX, Scryfall, milestones C0–C5)
- `docs/protocol/v1.md` — browser ⇄ bridge wire contract (**normative** for message shapes)
- `docs/plans/2026-07-21-table-client-design.md` — **the table client** (Pixi), bridge M6 +
  milestones T0–T6. This is the current work; `docs/client/design.md` is the classic client it
  replaces
- `docs/plans/2026-07-15-xmage-bridge-spike.md` — XMage session API map, spike findings

## Layout

- `bridge/` — Maven project `night-bridge` (the daemon). Spike/capture tool under
  `bridge/src/spike/java`, activated by `-Pspike`.
- npm workspaces (root `package.json`): `packages/core` (`@night/core` — protocol, net, stores,
  state, images, the semantic test harness; shared by both clients), `client/` (the classic React
  client, deployed at `/classic`), `table/` (the Pixi table client, deployed at `/`), `e2e/`
  (`@night/e2e` — the live Playwright tier, one spec set for either client).
- `vendor/` (gitignored) — `xmage-dist/` runnable server + client jars; `mage/` shallow source
  clone for reading XMage internals; `tools/`.
- `docs/deploy/` — genericized, publishable deployment templates (systemd units, Caddyfile, prod
  `bridge.yaml.example`) and a generic runbook. Build the dist artifacts with
  `mvn -Pdist -DskipTests package`.
- `deploy/` (gitignored, host-specific — not committed) — the live host's real units/config and
  operational runbook; a local, un-genericized mirror of `docs/deploy/`. Deployment context for
  working in it is in `deploy/CLAUDE.md`.
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
(cd vendor/xmage-dist/xmage/mage-server && ../../java/jre1.8.0_201/bin/java -Xmx2048m -jar lib/mage-server-1.4.63.jar)

cd bridge && mvn -Plive test                   # live tier: full game vs 3 AIs through the bridge
cd bridge && mvn -Prun compile exec:exec       # the bridge daemon (repo-root cwd, JDK-26 flags)
cd bridge && mvn -Pharness compile exec:exec   # interactive terminal client (human seat)
cd bridge && mvn -Pspike compile exec:exec     # the spike/fixture-capture tool (repo-root cwd)

npm test                          # every JS workspace's unit tier (core · client · table)
cd table && npm run dev           # the table client on :5273  (classic: cd client, :5173)

# Live browser tier (`e2e/`, one spec set for either client — needs XMage + bridge + that
# client's dev server up). NIGHT_BASE_URL overrides the port, e.g. a deployed host:
npm run e2e:table                 # the table client   ·  e2e:classic for the classic one
npm run e2e:table:preview         # ...against the built bundle (needs `npm run preview:harness`)
npx playwright test -c e2e/playwright.config.ts two-browser   # one spec (12 s smoke)
```

## Hard constraints

- **XMage version is pinned (1.4.63, upgraded from 1.4.60 on 2026-11-14)** and the bridge must compile against the dist's own jars —
  the server rejects any non-exact `MageVersion` handshake. On upgrade: replace
  `vendor/xmage-dist`, re-run the install script, bump `xmage.version` in `bridge/pom.xml`,
  regenerate golden fixtures, and publish the new `mage`/`mage-common` jars as an
  `xmage-jars-<version>` GitHub release + update the checksums in `.github/workflows/ci.yml`
  (CI's unit tier runs `mvn test -Dxmage.unit-only`, which needs only those two jars). XMage serialization is *not* stable across versions (1.4.63
  changed `ChoiceImpl`'s `serialVersionUID`), so old `logs/tap` captures stop decoding — archive
  them (`bridge/logs/tap-<oldversion>/`) and replay against fresh captures.
- Central deps that shadow dist jars (guava, gson, protobuf, jsoup, commons-lang3, reload4j)
  must stay version-identical to the dist's `mage-client/lib`.
- JDK 26 needs `--add-opens=java.base/java.io=ALL-UNNAMED` (+ `java.lang`) and
  `-Djava.awt.headless=true` for the XMage session layer; the `-Pspike` exec config sets them.
- XMage callbacks: always `callback.decompressData()` before `getData()`; read `Choice` payloads
  through typed getters; callbacks arrive on up to 10 threads (bridge serializes per seat pump).
- **Exactly one positional answer per XMage ask, sent through `XmageAnswers`** (it paces each send
  ≥150 ms after the ask). XMage parks a send from a seat it isn't asking for up to 30 s and
  delivers it to that seat's *next* ask. So any extra send, like a speculative "nudge", shifts every
  later answer one ask late. That wedged prod game K32ZYQ in a 14,000-lap loop (design.md §5).
  Never bypass it with raw `session.sendPlayer*`.
- Logging is split: our code → slf4j/logback; mage classes → log4j-1.x API via reload4j
  (`log4j.properties`). Never add an `slf4j-reload4j` binding.

## Conventions

- Modern Java (release 25): records + sealed interfaces for protocol types, virtual threads.
- One owning executor per piece of mutable state (design §4) — no shared-state shortcuts.
- Wire-protocol changes happen in `docs/protocol/v1.md` first, then code follows.
- **Both client packages need `resolve.dedupe: ['react', 'react-dom']`** in their vite config. The
  root `overrides` pin keeps react inside each package while zustand hoists to the repo root, so
  bundling the root's zustand leaves its `import 'react'` unresolvable — and rolldown does *not*
  fail the build over it: it emits a top-level `throw Error("Could not resolve \"react\"…")` and
  drops everything after it. The classic client shipped that for two days (a bundle with no UI, and
  `npm run build` exit 0). After any build, sanity-check the output by grepping it for one of its own
  class names (`grep -c prompt-dock dist/assets/index-*.js`) — size alone won't tell you.
