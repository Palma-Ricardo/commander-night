package night.bridge.live;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.flipkart.zjsonpatch.JsonPatch;
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
import java.util.ArrayDeque;
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

    private static final ObjectMapper json = new ObjectMapper();
    private static final Path SAMPLE_DECK =
            Path.of("..", "vendor", "xmage-dist", "xmage", "mage-client", "sample-decks",
                    "Commander", "Tasigur BGU.dck");

    // ---- invariant auditor: fed every frame the client receives ----

    private static final class Auditor {
        long lastSeq = -1;
        long lastStateSeq = -1;
        JsonNode applied;                 // the patch-maintained state tree
        boolean expectResyncKeyframe;     // next keyframe must equal `applied`
        Long pendingPromptId;
        int keyframes;
        int patches;
        int promptsSeen;
        int promptsAnswered;
        int logLines;
        long gameBytes;
        String lastStatus;
        String gameId;
        boolean sawOver;
        JsonNode gameOver;
        final List<String> violations = new ArrayList<>();

        void observe(JsonNode n, int frameLength) {
            String t = n.path("t").asText("");
            if (!t.startsWith("game.")) {
                return;
            }
            gameBytes += frameLength;
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
                    gameId = n.path("gameId").asText();
                    JsonNode state = n.get("state");
                    if (state == null || !state.has("players")) {
                        violations.add("keyframe without players at seq " + lastSeq);
                        return;
                    }
                    if (expectResyncKeyframe) {
                        expectResyncKeyframe = false;
                        if (applied != null && !state.equals(applied)) {
                            violations.add("resync keyframe at seq " + lastSeq
                                    + " differs from the patch-applied tree");
                        }
                    }
                    applied = state.deepCopy();
                    lastStateSeq = lastSeq;
                    String status = state.path("status").asText();
                    if ("over".equals(lastStatus) && "active".equals(status)) {
                        violations.add("status went over -> active at seq " + lastSeq);
                    }
                    lastStatus = status;
                    if ("over".equals(status)) {
                        sawOver = true;
                    }
                }
                case "game.patch" -> {
                    patches++;
                    long base = n.path("base").asLong();
                    if (base != lastStateSeq) {
                        violations.add("patch base " + base + " != last state event "
                                + lastStateSeq + " at seq " + lastSeq);
                    }
                    for (JsonNode op : n.path("ops")) {
                        if (!Set.of("add", "remove", "replace").contains(op.path("op").asText())) {
                            violations.add("forbidden patch op at seq " + lastSeq + ": " + op);
                        }
                    }
                    if (applied == null) {
                        violations.add("patch before any keyframe at seq " + lastSeq);
                        return;
                    }
                    try {
                        applied = JsonPatch.apply(n.get("ops"), applied);
                    } catch (Exception e) {
                        violations.add("patch failed to apply at seq " + lastSeq + ": " + e.getMessage());
                    }
                    lastStateSeq = lastSeq;
                    String status = applied.path("status").asText();
                    if ("over".equals(status)) {
                        sawOver = true;
                    }
                    lastStatus = status;
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
        /** Prompts pulled mid-await (e.g. racing a resync keyframe) — must be answered, not dropped. */
        final ArrayDeque<JsonNode> stash = new ArrayDeque<>();
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

        // the default Listener swallows both — a dead WS would look like silence
        @Override
        public void onError(WebSocket ws, Throwable error) {
            System.out.println("[live] WS ERROR: " + error);
            error.printStackTrace(System.out);
        }

        @Override
        public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
            System.out.println("[live] WS CLOSED " + statusCode + " '" + reason + "'");
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
                auditor.observe(n, frame.length());
                if ("error".equals(n.path("t").asText())
                        && !"PROMPT_STALE".equals(n.path("code").asText())) {
                    fail("unexpected error frame: " + frame);
                }
                if (matcher.test(n)) {
                    return n;
                }
                if ("game.prompt".equals(n.path("t").asText())) {
                    // a prompt racing a targeted wait (resync keyframe, ack) — the game
                    // halts forever if it goes unanswered, so hold it for the main loop
                    stash.add(n);
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
        // session + lobby setup — patch mode (no stateMode override) is the point of M3
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
                    answer(c, n, repeats);
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
                        + "logLines=%d lastSeq=%d gameBytes=%.1fMB resyncs=%d%n",
                a.gameOver.path("reason").asText(), a.patches, a.keyframes,
                a.promptsAnswered, a.promptsSeen, a.logLines, a.lastSeq,
                a.gameBytes / 1_000_000.0, resyncsDone);
    }

    /**
     * The auto-player: keep hands, pass priority, never pay mana; required
     * selections are submitted whole-set ({@code objects}) to exercise the §8
     * replay live; the M3 kinds answer first-option/minimum.
     */
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
                int chosen = prompt.path("progress").path("chosen").asInt(0);
                int max = prompt.path("max").asInt(1);
                if (required && candidates.size() > 0) {
                    // whole-set submit — the bridge replays it one UUID at a time (§8)
                    int n = Math.min(max - chosen, candidates.size());
                    answer.put("type", "objects");
                    var arr = answer.putArray("objectIds");
                    for (int i = 0; i < Math.max(n, 1); i++) {
                        arr.add(candidates.get(i).asText());
                    }
                } else if (required) {
                    answer.put("type", "confirm").put("value", true);   // done — nothing to pick
                } else {
                    answer.put("type", "cancel");
                }
            }
            case "payMana" -> answer.put("type", "cancel");
            case "chooseAbility" -> answer.put("type", "object")
                    .put("objectId", prompt.path("options").get(0).path("id").asText());
            case "chooseOption" -> answer.put("type", "option")
                    .put("key", prompt.path("options").get(0).path("key").asText());
            case "choosePile" -> answer.put("type", "pile").put("index", 0);
            case "chooseAmount" -> answer.put("type", "number")
                    .put("value", prompt.path("min").asLong(0));
            case "distribute" -> {
                answer.put("type", "distribution");
                var arr = answer.putArray("amounts");
                for (JsonNode row : prompt.path("among")) {
                    arr.addObject().put("id", row.path("id").asText())
                            .put("amount", row.path("suggested").asLong(row.path("min").asLong(0)));
                }
            }
            case "playerRequest" -> answer.put("type", "option")
                    .put("key", prompt.path("options").get(0).path("key").asText());
            default -> fail("unknown prompt kind " + kind + ": " + prompt);
        }
        System.out.printf("[live] prompt #%d %s '%.60s' -> %s%n", promptId, kind, message, answer);
        c.send("game.answer", Map.of("gameId", gameId, "promptId", promptId, "answer", answer));
    }
}
