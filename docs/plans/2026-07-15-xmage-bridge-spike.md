# XMage Bridge Spike

**Date:** 2026-07-15 · **Status:** ✅ SUCCESS — architecture proven same day

**Outcome:** the headless bridge client played a complete 4-player Commander Free For All on a local server (self + 3 "Computer - mad" AIs, real sample Commander decks): 46 turns in 326s, 2,465 callbacks captured as JSON (191MB, zero Gson serialization failures), clean GAME_OVER/END_GAME_INFO + disconnect. ai_2 (Daxos) won; the bridge seat auto-passed everything as designed. Log: `bridge/logs/spike-1784169224029.jsonl`. Run it again: start server (`vendor/xmage-dist/xmage/mage-server`, bundled JRE), then `bridge/run-spike.sh`.

## Context

Commander Night's goal is 4-player online MTG Commander with full rules enforcement and a modern UX. We evaluated building a TypeScript rules engine from scratch and rejected it: the rules kernel (layers, replacement effects, SBAs, priority) plus per-card implementations is years of work, and Commander's singleton format is the worst case for card coverage (~400 unique cards on a table, decks change constantly). XMage's engine is mature and battle-tested, but its Swing client UX is bad (dated UI, poor deck import, hard-to-follow games).

**Decision:** keep XMage as the authoritative rules server (self-hosted, version-pinned). Build:

1. a **JVM-side bridge** that speaks XMage's native protocol (Java serialization over JBoss Remoting) to the server, and exposes **our own clean, versioned JSON/WebSocket protocol** to browsers — *not* a 1:1 mirror of XMage's view classes, so XMage stays a swappable backend;
2. a **TypeScript web client** on top of that protocol.

No maintained XMage web client exists (verified 2026-07-15); old forum attempts stalled at the protocol wall.

## Spike success criterion

A small JVM program that:

1. connects to a **local** XMage server as a client,
2. creates a Commander table, seats itself + 3 AI players, and starts the game,
3. streams **every** server callback (GameView state updates, prompts/choices) to a JSON-lines log for a full game.

If this works, the architecture is proven and everything after is product work. If it's still fighting back after ~a week of effort, stop and reassess (fallbacks below, or reconsider alternatives with real information in hand).

## Approach

- Use the **official binary distribution** rather than a full source build: it gives a runnable server *and* the exact `mage-common.jar` the bridge should compile against — same artifact the server runs, so Java-serialization compatibility is guaranteed. Avoids the very long Mage.Sets source build.
- Keep a **shallow source clone** purely for reading/navigating the API.
- Bridge is a Maven project; XMage jars installed into the local Maven repo via `install-file`; Jackson for JSON output.

## Steps

| # | Step | Status |
|---|------|--------|
| 1 | Shallow-clone XMage source → `vendor/mage` | ✅ done |
| 2 | Binary dist → `vendor/xmage-dist` (symlink to `mage-full_…/` already in repo; launcher-installed layout: client/server under `xmage/`, bundled JRE 8 under `java/`) | ✅ done |
| 3 | Standalone Apache Maven 3.9.16 → `vendor/tools` (not needed for spike — javac against dist jars sufficed; keep for the real bridge) | ✅ done |
| 4 | Map the client session API in Mage.Common | ✅ done — see findings below |
| 5 | Scaffold `bridge/` — plain javac build (`bridge/build.sh`, `--release 8`) against `mage-client/lib/*`; Gson (from dist) for JSON, not Jackson | ✅ done |
| 6 | Implement `SpikeMain`: connect, create Commander table + 3 AI, answer/skip prompts minimally, log every callback as JSON lines | ✅ done — `bridge/src/night/spike/SpikeMain.java` |
| 7 | Run end-to-end against local server; capture a full game log; review the shape of GameView data to inform our JSON protocol design | ⏳ running — connect/handshake/table/seating/match-start all worked first try; game in progress, 800+ callbacks logged, 0 Gson serialization errors |

## Key API findings (session API map, 2026-07-15)

- XMage's own headless client lives in `Mage.Tests/src/test/java/org/mage/test/load/` (`SimpleMageClient`, `LoadCallbackClient`, `LoadTest`) — the spike is modeled on it.
- Bridge implements `mage.interfaces.MageClient` (7 methods); `new SessionImpl(client)` + `connectStart(Connection)`. Version handshake requires EXACT `MageVersion` match — guaranteed by compiling against the dist's own `mage-common-1.4.60.jar`.
- Callbacks: `onCallback(ClientCallback)` — MUST call `callback.decompressData()` before `getData()`; can arrive on up to 10 threads → synchronize. Prompt answers via `session.sendPlayerBoolean/UUID/Integer/String/ManaType/Action`.
- Table recipe: `getMainRoomId()` → `createTable(roomId, MatchOptions)` → creator `joinTable(...)` once per AI seat (`PlayerType.COMPUTER_MAD`, "Computer - mad") then own HUMAN seat → `startMatch(roomId, tableId)`. On `START_GAME` callback: `session.joinGame(gameId)`.
- MatchOptions for Commander FFA: game type `"Commander Free For All"`, deck type `"Variant Magic - Commander"`, `multiPlayer=false`, range ALL, attack MULTIPLE; start life 40 comes from the game type, not options.
- Decks: `DeckCardLists`/`DeckCardInfo(name, cardNumber, setCode)`; commander goes in the sideboard; main+SB must total exactly 100. The `.dck` format is trivially parseable — the spike parses it directly, avoiding any client-side card DB.
- Keepalive: call `session.ping()` on a timer (Swing client uses 20s); JBoss lease/validator handles transport level automatically.
- Run headless with `-Djava.awt.headless=true` (SessionImpl uses SwingWorker internally). Everything runs fine under the dist's bundled JRE 8.
- Protocol insight for our design: XMage sends FULL GameView snapshots per update (~38MB JSON for the first minute of a 4-player game) — our browser protocol should diff/trim, not mirror.

## Environment facts

- CachyOS (Arch), JDK 26 (javac 26.0.1), git 2.55. No system Maven; assume no root — tools go in `vendor/tools`.
- XMage upstream supports running under any modern Java; bridge compiled with javac 26 against Java-8-era jars is fine (newer javac consumes old bytecode).
- Public server for reference: `beta.xmage.today:17171` (no registration). **The spike uses a local server only.**
- No prior XMage install found on this machine; dist is being downloaded fresh.

## Risks & fallbacks

- **Serialization/version mismatch bridge↔server** — mitigated by compiling against jars from the same dist the server runs. Fallback: full source build (`mvn install -DskipTests` in `vendor/mage`) and run server from source so both sides share one source tree.
- **JBoss Remoting misbehaves under JDK 26** — fallback: download a Temurin 17 tarball into `vendor/tools` and run server + bridge under it (no root needed).
- **Prompt auto-answering** — a game may stall on a choice the spike can't answer; acceptable, since logging the callback flow is the goal. Mitigations: auto-pass priority / auto-concede options, or answer with first-legal-choice.
- **Session API too entangled with the Swing client** — fallback: drive `Mage.Client`'s non-UI session/callback classes headlessly, or log callbacks reflectively first and refine.

## Layout

```
commander-night/
  docs/plans/            # this file
  bridge/                # spike code (Maven)
  vendor/mage/           # shallow source clone — read-only reference (gitignored)
  vendor/xmage-dist/     # binary distribution: runnable server + client jars (gitignored)
  vendor/tools/          # standalone Maven, maybe a pinned JDK (gitignored)
```

## After the spike

Next decisions once proven: design the browser-facing JSON protocol (semantic messages, versioned), bridge process architecture (one process per game vs. multiplexed), lobby/table UX owned by our client, deck import UX (ours end-to-end; bridge submits `.dck`).
