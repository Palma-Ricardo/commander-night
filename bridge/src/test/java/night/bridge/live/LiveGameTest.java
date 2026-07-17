package night.bridge.live;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.javalin.Javalin;
import night.bridge.config.Config;
import night.bridge.game.Games;
import night.bridge.lobby.LobbyService;
import night.bridge.net.Codec;
import night.bridge.net.SessionRegistry;
import night.bridge.net.WsEndpoint;
import night.bridge.xmage.XmageGateway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Predicate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The M2 exit criterion as a test (design §13 live tier, §14): a raw-WS
 * client plays a full Commander game against 3 AIs through the whole bridge
 * stack, auto-answering every prompt, while auditing protocol invariants on
 * every received frame:
 *
 * <ul>
 *   <li>game.* event seq is gapless and strictly ordered per seat;</li>
 *   <li>at most one prompt pending — every prompt is promptDone'd before the next;</li>
 *   <li>keyframes always parse into the §6 shape (4 players, status transitions
 *       active → over exactly once);</li>
 *   <li>no error frames beyond benign PROMPT_STALE races;</li>
 *   <li>the game reaches game.over with a final keyframe first.</li>
 * </ul>
 *
 * Requires a local XMage server on 17171 (skipped otherwise): run
 * {@code mvn -Plive test}. This doubles as the JDK-26 session-layer soak.
 */
@Tag("live")
class LiveGameTest {

    private static final ObjectMapper json = new ObjectMapper();
    private static final Path SAMPLE_DECK =
            Path.of("..", "vendor", "xmage-dist", "xmage", "mage-client", "sample-decks",
                    "Commander", "Tasigur BGU.dck");

    // ---- invariant auditor: fed every frame the client receives ----

    private static final class Auditor {
        long lastSeq = -1;
        Long pendingPromptId;
        int keyframes;
        int promptsSeen;
        int promptsAnswered;
        int logLines;
        String lastStatus;
        boolean sawOver;
        JsonNode gameOver;
        JsonNode lastKeyframe;
        final List<String> violations = new ArrayList<>();

        void observe(JsonNode n) {
            String t = n.path("t").asText("");
            if (!t.startsWith("game.")) {
                return;
            }
            if (n.has("seq")) {
                long seq = n.get("seq").asLong();
                if (seq != lastSeq + 1) {
                    violations.add("seq gap: " + lastSeq + " -> " + seq + " on " + t);
                }
                lastSeq = seq;
            }
            switch (t) {
                case "game.state" -> {
                    keyframes++;
                    lastKeyframe = n;
                    JsonNode state = n.get("state");
                    if (state == null || !state.has("players")) {
                        violations.add("keyframe without players at seq " + lastSeq);
                        return;
                    }
                    String status = state.path("status").asText();
                    if ("over".equals(lastStatus) && "active".equals(status)) {
                        violations.add("status went over -> active at seq " + lastSeq);
                    }
                    lastStatus = status;
                    if ("over".equals(status)) {
                        sawOver = true;
                    }
                }
                case "game.prompt" -> {
                    promptsSeen++;
                    if (pendingPromptId != null) {
                        violations.add("prompt " + n.path("promptId").asLong()
                                + " arrived while " + pendingPromptId + " still pending");
                    }
                    pendingPromptId = n.path("promptId").asLong();
                }
                case "game.promptDone" -> {
                    long id = n.path("promptId").asLong();
                    if (pendingPromptId == null || pendingPromptId != id) {
                        violations.add("promptDone " + id + " but pending was " + pendingPromptId);
                    }
                    if ("answered".equals(n.path("reason").asText())) {
                        promptsAnswered++;
                    }
                    pendingPromptId = null;
                }
                case "game.log" -> logLines++;
                case "game.over" -> gameOver = n;
                default -> {
                }
            }
        }
    }

    // ---- minimal blocking WS client ----

    private static final class Client implements WebSocket.Listener {
        final BlockingQueue<String> frames = new LinkedBlockingQueue<>();
        final StringBuilder partial = new StringBuilder();
        final AtomicInteger cmdIds = new AtomicInteger();
        final Auditor auditor = new Auditor();
        WebSocket ws;

        static Client connect(int port) {
            Client c = new Client();
            c.ws = HttpClient.newHttpClient().newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws"), c)
                    .join();
            return c;
        }

        @Override
        public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
            partial.append(data);
            if (last) {
                frames.add(partial.toString());
                partial.setLength(0);
            }
            ws.request(1);
            return null;
        }

        String send(String type, Map<String, Object> fields) {
            String id = "c" + cmdIds.incrementAndGet();
            ObjectNode n = json.createObjectNode().put("t", type).put("id", id);
            fields.forEach((k, v) -> {
                switch (v) {
                    case String s -> n.put(k, s);
                    case Boolean b -> n.put(k, b);
                    case Integer i -> n.put(k, i);
                    case Long l -> n.put(k, l);
                    case JsonNode jn -> n.set(k, jn);
                    default -> throw new IllegalArgumentException(String.valueOf(v));
                }
            });
            ws.sendText(n.toString(), true).join();
            return id;
        }

        /** Pulls frames (auditing each) until one matches; fails on timeout. */
        JsonNode await(String what, long timeoutSecs, Predicate<JsonNode> matcher) throws Exception {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSecs);
            while (true) {
                long waitNanos = deadline - System.nanoTime();
                if (waitNanos <= 0) {
                    fail("timed out waiting for " + what);
                }
                String frame = frames.poll(Math.min(waitNanos, TimeUnit.SECONDS.toNanos(5)),
                        TimeUnit.NANOSECONDS);
                if (frame == null) {
                    continue;
                }
                JsonNode n = json.readTree(frame);
                auditor.observe(n);
                if ("error".equals(n.path("t").asText())
                        && !"PROMPT_STALE".equals(n.path("code").asText())) {
                    fail("unexpected error frame: " + frame);
                }
                if (matcher.test(n)) {
                    return n;
                }
            }
        }

        JsonNode awaitAck(String what, String id) throws Exception {
            return await("ack for " + what, 30,
                    n -> "ack".equals(n.path("t").asText()) && id.equals(n.path("re").asText()));
        }
    }

    private static boolean xmageUp() {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress("127.0.0.1", 17171), 500);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    @Test
    @Timeout(value = 20, unit = TimeUnit.MINUTES)
    void fullGameAgainstThreeAis() throws Exception {
        assumeTrue(xmageUp(), "local XMage server on 17171 required (vendor/xmage-dist)");

        Config config = new Config("127.0.0.1:0", new Config.Xmage("127.0.0.1", 17171),
                100, new Config.LogBackfill(200, 50), false,
                "../vendor/xmage-dist/xmage/mage-client/sample-decks/Commander");
        SessionRegistry registry = new SessionRegistry();
        XmageGateway gateway = new XmageGateway(config);
        Games games = new Games();
        LobbyService lobby = new LobbyService(registry, gateway, games, config);
        Javalin app = new WsEndpoint(new Codec(), registry, lobby, games, gateway::health).buildApp();
        app.start("127.0.0.1", 0);
        try {
            runGame(Client.connect(app.port()));
        } finally {
            app.stop();
            lobby.close();
            gateway.close();
            registry.close();
        }
    }

    private void runGame(Client c) throws Exception {
        // session + lobby setup
        String helloId = c.send("session.hello", Map.of("v", 1));
        c.await("welcome", 10, n -> "session.welcome".equals(n.path("t").asText())
                && helloId.equals(n.path("re").asText()));

        c.awaitAck("lobby.create", c.send("lobby.create", Map.of("format", "commander-ffa")));
        JsonNode lobbyState = c.await("lobby.state with code", 10,
                n -> "lobby.state".equals(n.path("t").asText()) && n.hasNonNull("code"));
        String code = lobbyState.get("code").asText();

        c.awaitAck("lobby.join", c.send("lobby.join", Map.of("code", code, "displayName", "Ricardo")));
        c.awaitAck("lobby.deck", c.send("lobby.deck",
                Map.of("format", "dck", "content", Files.readString(SAMPLE_DECK))));
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
        JsonNode over = null;
        while (over == null) {
            JsonNode n = c.await("next game event", 120, x -> true);
            switch (n.path("t").asText()) {
                case "game.prompt" -> answer(c, n, repeats);
                case "game.over" -> over = n;
                default -> {
                }
            }
        }

        // ---- exit assertions ----
        Auditor a = c.auditor;
        assertEquals(List.of(), a.violations, "protocol invariant violations");
        assertTrue(a.keyframes > 20, "expected a real game's worth of keyframes, got " + a.keyframes);
        assertTrue(a.promptsSeen >= 1 && a.promptsAnswered >= 1,
                "expected at least the mulligan prompt (seen=" + a.promptsSeen
                        + ", answered=" + a.promptsAnswered + ")");
        assertTrue(a.logLines > 10, "expected a real game log, got " + a.logLines + " lines");
        assertTrue(a.sawOver, "final keyframe must carry status:over before game.over");
        assertNotNull(a.gameOver);
        assertTrue(a.gameOver.path("finalState").asBoolean());
        assertNotNull(a.gameOver.get("reason"));

        JsonNode players = a.lastKeyframe.path("state").path("players");
        assertEquals(4, players.size(), "4 seats in the final keyframe");
        Set<String> playerIds = new HashSet<>();
        players.forEach(p -> playerIds.add(p.path("id").asText()));
        for (JsonNode w : a.gameOver.path("winnerPlayerIds")) {
            assertTrue(playerIds.contains(w.asText()), "winner must be a seated player");
        }
        System.out.printf("[live] game over: %s | keyframes=%d prompts=%d/%d logLines=%d lastSeq=%d%n",
                a.gameOver.path("reason").asText(), a.keyframes,
                a.promptsAnswered, a.promptsSeen, a.logLines, a.lastSeq);
    }

    /** The auto-player: keep hands, pass priority, discard/pick first when forced, never pay mana. */
    private void answer(Client c, JsonNode prompt, Map<String, Integer> repeats) {
        long promptId = prompt.path("promptId").asLong();
        String gameId = prompt.path("gameId").asText();
        String kind = prompt.path("kind").asText();
        String message = prompt.path("message").asText();
        ObjectNode answer = json.createObjectNode();
        switch (kind) {
            case "confirm" -> {
                int seen = repeats.merge("confirm|" + message, 1, Integer::sum);
                boolean yes;
                if (message.contains("Mulligan")) {
                    yes = false;                       // keep every hand
                } else if (message.contains("Pass anyway") || message.contains("mana pool")) {
                    yes = true;                        // don't wedge on floating mana
                } else {
                    yes = seen > 5;                    // escape an unforeseen repeating ask
                }
                answer.put("type", "confirm").put("value", yes);
            }
            case "priority" -> answer.put("type", "confirm").put("value", false);
            case "chooseTargets" -> {
                boolean required = prompt.path("required").asBoolean();
                JsonNode candidates = prompt.path("candidates");
                if (required && candidates.size() > 0) {
                    answer.put("type", "object").put("objectId", candidates.get(0).asText());
                } else if (required) {
                    answer.put("type", "confirm").put("value", true);   // done — nothing to pick
                } else {
                    answer.put("type", "cancel");
                }
            }
            case "payMana" -> answer.put("type", "cancel");
            default -> {
                // design §8: unmapped kinds never reach game.prompt in M2
                fail("unexpected prompt kind " + kind + ": " + prompt);
            }
        }
        c.send("game.answer", Map.of("gameId", gameId, "promptId", promptId, "answer", answer));
    }
}
