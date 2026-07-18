package night.bridge.live;

import com.fasterxml.jackson.databind.JsonNode;
import io.javalin.Javalin;
import night.bridge.config.Config;
import night.bridge.game.Games;
import night.bridge.lobby.LobbyService;
import night.bridge.live.LiveHarness.Auditor;
import night.bridge.live.LiveHarness.Client;
import night.bridge.net.Codec;
import night.bridge.net.SessionRegistry;
import night.bridge.net.WsEndpoint;
import night.bridge.xmage.XmageGateway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Files;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import static night.bridge.live.LiveHarness.autoAnswer;
import static night.bridge.live.LiveHarness.json;
import static night.bridge.live.LiveHarness.xmageUp;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The M3 exit criterion as a test (design §13 live tier, §14): a raw-WS
 * client plays a full Commander game against 3 AIs through the whole bridge
 * stack — in patch mode — auto-answering every prompt, while auditing
 * protocol invariants on every received frame:
 *
 * <ul>
 *   <li>game.* event seq is gapless and strictly ordered per seat;</li>
 *   <li>every patch's {@code base} matches the last applied state event, its
 *       ops are add/remove/replace only, and it applies cleanly onto the
 *       running tree;</li>
 *   <li>a mid-game {@code game.resync} keyframe equals the patch-applied
 *       tree byte-for-byte (the §7 apply-and-compare);</li>
 *   <li>at most one prompt pending — every prompt is promptDone'd before the next;</li>
 *   <li>required target selections are answered whole-set ({@code objects}),
 *       exercising the §8 replay live;</li>
 *   <li>combat declaration fires and completes: the seat plays lands, casts,
 *       and attacks with one creature per combat, so `priority`+`combat`
 *       toggle → defender pick → done round-trips run in every game (the
 *       pacifist M3 auto-player never held a creature, and XMage skips the
 *       ask entirely for a creatureless seat — the blind spot that hid the
 *       combat gap through 8/8 validation games);</li>
 *   <li>no error frames beyond benign PROMPT_STALE races;</li>
 *   <li>the game reaches game.over with a final keyframe first, and total
 *       game.* wire bytes stay within the §7 budget.</li>
 * </ul>
 *
 * Requires a local XMage server on 17171 (skipped otherwise): run
 * {@code mvn -Plive test}. This doubles as the JDK-26 session-layer soak.
 */
@Tag("live")
class LiveGameTest {

    @Test
    @Timeout(value = 20, unit = TimeUnit.MINUTES)
    void fullGameAgainstThreeAis() throws Exception {
        assumeTrue(xmageUp(), "local XMage server on 17171 required (vendor/xmage-dist)");

        Config config = new Config("127.0.0.1:0", new Config.Xmage("127.0.0.1", 17171),
                100, new Config.LogBackfill(200, 50), false,
                "../vendor/xmage-dist/xmage/mage-client/sample-decks/Commander", 900);
        Games games = new Games();
        SessionRegistry registry = new SessionRegistry(games);
        XmageGateway gateway = new XmageGateway(config);
        LobbyService lobby = new LobbyService(registry, gateway, games, config);
        Javalin app = new WsEndpoint(new Codec(), registry, lobby, games, gateway::health).buildApp();
        app.start("127.0.0.1", 0);
        try {
            runGame(Client.connect(app.port(), "solo"));
        } finally {
            app.stop();
            lobby.close();
            gateway.close();
            registry.close();
        }
    }

    private void runGame(Client c) throws Exception {
        // session + lobby setup — patch mode (no stateMode override) is the point of M3
        c.hello(Map.of());

        c.awaitAck("lobby.create", c.send("lobby.create", Map.of("format", "commander-ffa")));
        JsonNode lobbyState = c.await("lobby.state with code", 10,
                n -> "lobby.state".equals(n.path("t").asText()) && n.hasNonNull("code"));
        String code = lobbyState.get("code").asText();

        c.awaitAck("lobby.join", c.send("lobby.join", Map.of("code", code, "displayName", "Ricardo")));
        c.awaitAck("lobby.deck", c.send("lobby.deck",
                Map.of("format", "dck", "content", Files.readString(LiveHarness.SAMPLE_DECK))));
        JsonNode afterDeck = c.await("lobby.state with deck", 10,
                n -> "lobby.state".equals(n.path("t").asText())
                        && n.path("seats").size() == 1 && n.path("seats").get(0).has("deck"));
        assertTrue(afterDeck.path("seats").get(0).path("deck").path("valid").asBoolean(),
                "sample deck must validate: " + afterDeck);

        c.awaitAck("lobby.ready", c.send("lobby.ready", Map.of("ready", true)));
        // table setup takes a few seconds: 1 connect + createTable + 4 joins + startMatch
        c.awaitAck("lobby.start", c.send("lobby.start", Map.of("fillAI", true)));

        // game loop: answer every prompt until game.over
        Map<String, Integer> repeats = new HashMap<>();
        boolean actionSent = false;
        int resyncsDone = 0;
        JsonNode over = null;
        while (over == null) {
            // 300 s: degenerate late-game boards chain AI think-timeouts (skill×3 s each,
            // 3 AIs, deep stacks) — 170 s+ of legitimate ask-silence observed live. The
            // pump's nudge watchdog keeps the seat safe through it (design §5).
            JsonNode n = c.stash.poll();
            if (n == null) {
                n = c.await("next game event", 300, x -> true);
            }
            switch (n.path("t").asText()) {
                case "game.prompt" -> {
                    autoAnswer(c, n, repeats);
                    if (!actionSent) {
                        // one harmless prompt-free game.action through the full stack (§9)
                        actionSent = true;
                        c.awaitAck("game.action", c.send("game.action", Map.of(
                                "gameId", n.path("gameId").asText(),
                                "action", json.createObjectNode().put("kind", "autoMana").put("enabled", true))));
                    }
                }
                case "game.over" -> over = n;
                default -> {
                }
            }
            // §7 apply-and-compare: three mid-game resyncs at growing patch depths
            if (resyncsDone < 3 && c.auditor.patches >= 50 + resyncsDone * 150
                    && c.auditor.gameId != null) {
                resyncsDone++;
                String id = c.send("game.resync", Map.of("gameId", c.auditor.gameId));
                c.awaitAck("game.resync", id);
                // ack and forced keyframe are emitted back-to-back on the pump, so
                // the very next state event is the comparable keyframe — arm only now
                c.auditor.expectResyncKeyframe = true;
                c.await("resync keyframe", 30, x -> "game.state".equals(x.path("t").asText()));
            }
        }

        // ---- exit assertions ----
        Auditor a = c.auditor;
        assertEquals(List.of(), a.violations, "protocol invariant violations");
        assertTrue(a.patches > 100, "expected a real game's worth of patches, got " + a.patches);
        assertTrue(a.keyframes < a.patches / 10 + 6,
                "patch mode must not spray keyframes: " + a.keyframes + " kf / " + a.patches + " patches");
        assertTrue(resyncsDone >= 1, "the apply-and-compare resync must have run at least once");
        assertTrue(a.promptsSeen >= 1 && a.promptsAnswered >= 1,
                "expected at least the mulligan prompt (seen=" + a.promptsSeen
                        + ", answered=" + a.promptsAnswered + ")");
        // the seat casts creatures now, so combat declaration must fire — a zero
        // here means the auto-player regressed to pacifism and the combat path
        // (the M3 blind spot) went unexercised again
        assertTrue(a.combatPrompts >= 1,
                "expected at least one combat declaration ask (priority+combat), got 0");
        assertTrue(a.logLines > 10, "expected a real game log, got " + a.logLines + " lines");
        assertTrue(a.sawOver, "final keyframe must carry status:over before game.over");
        assertNotNull(a.gameOver);
        assertTrue(a.gameOver.path("finalState").asBoolean());
        assertNotNull(a.gameOver.get("reason"));
        // §7 budget: ≈1–3 MB/seat/game pre-compression; hard ceiling with headroom
        assertTrue(a.gameBytes < 12_000_000,
                "game.* wire bytes blew the §7 budget: " + a.gameBytes);

        JsonNode players = a.applied.path("players");
        assertEquals(4, players.size(), "4 seats in the final state");
        Set<String> playerIds = new HashSet<>();
        players.forEach(p -> playerIds.add(p.path("id").asText()));
        for (JsonNode w : a.gameOver.path("winnerPlayerIds")) {
            assertTrue(playerIds.contains(w.asText()), "winner must be a seated player");
        }
        System.out.printf("[live] game over: %s | patches=%d keyframes=%d prompts=%d/%d "
                        + "combat=%d logLines=%d lastSeq=%d gameBytes=%.1fMB resyncs=%d%n",
                a.gameOver.path("reason").asText(), a.patches, a.keyframes,
                a.promptsAnswered, a.promptsSeen, a.combatPrompts, a.logLines, a.lastSeq,
                a.gameBytes / 1_000_000.0, resyncsDone);
    }
}
