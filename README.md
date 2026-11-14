# Commander Night

4-player online **Magic: The Gathering** Commander with full rules enforcement — playable in the browser.

Commander Night doesn't reimplement the rules of Magic. Instead, a self-hosted, version-pinned
[**XMage**](https://xmage.today/) server acts as the authoritative rules engine, and a **JVM bridge**
translates XMage's native protocol (Java serialization over JBoss Remoting) into a clean
JSON/WebSocket contract that browsers can speak. On top of that sit two TypeScript web clients that
share one core library.

## Architecture

```
Browser (TS client)  ──JSON/WebSocket (protocol v1)──►  JVM bridge  ──XMage native protocol──►  XMage server
     ▲                                                       │        (Java serialization,           (authoritative
     └───────────────── prompts, events, state ◄────────────┘         JBoss Remoting)                 rules engine)
```

- **XMage server** — the authoritative Magic rules engine. Self-hosted and **pinned to version
  1.4.63**; the bridge compiles against the dist's own jars because the server rejects any non-exact
  version handshake. XMage jars are vendored locally (gitignored), not pulled from Central.
- **The bridge** (`bridge/`) — a Maven daemon (`night-bridge`) written in modern Java (records,
  sealed interfaces, virtual threads). It speaks XMage's serialized protocol upstream and our own
  JSON/WebSocket **protocol v1** downstream, deriving high-level game *events* from XMage's callback
  stream and enforcing the delicate timing rules XMage's `HumanPlayer` needs (see the design docs).
- **The clients** — two TypeScript web apps sharing a `@night/core` library:
  - `client/` — the React "classic" client, deployed at `/classic` as the stable fallback.
  - `table/` — the PixiJS "table client" (a rendered felt table with camera and animation),
    deployed at `/`.

## Layout

| Path | What it is |
|------|-----------|
| `bridge/` | Maven project `night-bridge` — the JVM daemon. Spike/capture tooling under `bridge/src/spike/java` (`-Pspike`). |
| `packages/core` | `@night/core` — protocol, networking, stores, state, image handling, and the semantic test harness. Shared by both clients. |
| `client/` | The React "classic" web client (deployed at `/classic`). |
| `table/` | The PixiJS "table" web client (deployed at `/`). |
| `e2e/` | `@night/e2e` — the live Playwright tier; one spec set drives either client by base URL. |
| `docs/` | Specs and design docs (see below). Includes the normative wire-protocol contract and a conformance corpus. |
| `vendor/` | *(gitignored)* the runnable XMage dist, a shallow `mage/` source clone, and tools. |

## Documentation

The design is spec-first. Start with these:

- [`docs/protocol/v1.md`](docs/protocol/v1.md) — the browser ⇄ bridge wire contract (**normative**).
- [`docs/bridge/design.md`](docs/bridge/design.md) — bridge implementation spec (threading, translation, FSM, milestones).
- [`docs/client/design.md`](docs/client/design.md) — the classic TS client spec.
- [`docs/plans/2026-07-21-table-client-design.md`](docs/plans/2026-07-21-table-client-design.md) — the table client (Pixi), current work.
- [`docs/plans/2026-07-15-xmage-bridge-spike.md`](docs/plans/2026-07-15-xmage-bridge-spike.md) — XMage session API map and spike findings.

## Getting started

You need **JDK 26**, **Node.js** (with npm workspaces), and a local copy of the pinned **XMage 1.4.63**
distribution under `vendor/`.

### One-time setup

```sh
# Install the XMage jars into the local Maven repo (they are not on Central).
# Re-run after any dist upgrade.
./bridge/install-xmage-jars.sh

# Deck import reads XMage's card db through a hardcoded ./db path.
ln -sfn vendor/xmage-dist/xmage/mage-server/db db

# JS dependencies (npm workspaces, hoisted to the repo root).
npm install
```

### Running locally

```sh
# 1. Start the local XMage server (2048m matches prod).
(cd vendor/xmage-dist/xmage/mage-server && \
  ../../java/jre1.8.0_201/bin/java -Xmx2048m -jar lib/mage-server-1.4.63.jar)

# 2. Start the bridge daemon (repo-root cwd, JDK-26 flags).
cd bridge && mvn -Prun compile exec:exec

# 3. Start a web client dev server.
cd table  && npm run dev     # the table client on :5273
cd client && npm run dev     # the classic client on :5173
```

### Testing

```sh
cd bridge && mvn test              # bridge build + unit tests (live tier excluded)
cd bridge && mvn -Plive test       # live tier: a full game vs 3 AIs through the bridge
npm test                           # every JS workspace's unit tier (core · client · table)

npm run e2e:table                  # live browser tier against the table client
npm run e2e:classic                # ...against the classic client
```

## Notes on licensing & IP

This project builds on [XMage](https://github.com/magefree/mage), which is distributed under its own
license; the XMage distribution is vendored locally and **not** committed to this repository. *Magic:
The Gathering* is a trademark of Wizards of the Coast. This is a personal, non-commercial project for
playing with friends and is not affiliated with or endorsed by Wizards of the Coast or the XMage team.
