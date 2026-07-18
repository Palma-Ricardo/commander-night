package night.bridge.live;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.flipkart.zjsonpatch.JsonPatch;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Predicate;

import static org.junit.jupiter.api.Assertions.fail;

/**
 * Shared live-tier machinery (design §13): the invariant {@link Auditor}, the
 * minimal blocking WS {@link Client}, and the auto-player that can finish a
 * real game. Extracted from the M3 single-seat test so the M4 multi-human
 * test drives the same player through drops, resumes, and recovery joins.
 */
final class LiveHarness {

    static final ObjectMapper json = new ObjectMapper();
    static final Path SAMPLE_DECK =
            Path.of("..", "vendor", "xmage-dist", "xmage", "mage-client", "sample-decks",
                    "Commander", "Tasigur BGU.dck");

    private LiveHarness() {
    }

    static boolean xmageUp() {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress("127.0.0.1", 17171), 500);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    // ---- invariant auditor: fed every frame the client receives ----

    static final class Auditor {
        long lastSeq = -1;
        long lastStateSeq = -1;
        JsonNode applied;                 // the patch-maintained state tree
        boolean expectResyncKeyframe;     // next keyframe must equal `applied`
        Long pendingPromptId;
        int keyframes;
        int patches;
        int promptsSeen;
        int promptsAnswered;
        int combatPrompts;
        int logLines;
        int backfillLogs;                 // resume replays: log entries with an old seq
        int resumes;
        long gameBytes;
        String lastStatus;
        String gameId;
        boolean sawOver;
        JsonNode gameOver;
        final List<String> chatLines = new ArrayList<>();
        final List<String> violations = new ArrayList<>();

        /**
         * Bounded resume window (protocol §14): the replay is one contiguous
         * burst — keyframe (seq may jump forward), optionally the pending
         * prompt re-emitted under its old id, then old-seq backfill (log tail
         * / re-sent game.over). The window closes at the first fresh-seq event
         * that isn't that redelivered prompt, so outside a resume the auditor
         * keeps the absolute M3 invariants: every seq is exactly lastSeq+1 and
         * old-seq re-emissions are violations, never "backfill".
         */
        private boolean resumeSeqJump;
        private boolean resumeTail;
        private boolean resumePromptRedelivery;

        void expectResume() {
            resumes++;
            resumeSeqJump = true;
            resumeTail = true;
            resumePromptRedelivery = true;
        }

        /**
         * XMage seat recovery (design §5), as opposed to a browser resume: the
         * re-ground happens on the SAME socket — seq stays gapless, no log
         * backfill — but the pending prompt is re-emitted under its original
         * promptId, which must not read as a two-prompts-pending violation.
         */
        void expectRecoveryReground() {
            resumePromptRedelivery = true;
        }

        void observe(JsonNode n, int frameLength) {
            String t = n.path("t").asText("");
            if (!t.startsWith("game.")) {
                return;
            }
            gameBytes += frameLength;
            if (n.has("seq")) {
                long seq = n.get("seq").asLong();
                if (resumeSeqJump) {
                    // events emitted while disconnected are gone — the resume
                    // keyframe (always first, §14) restarts gap tracking
                    if (!"game.state".equals(t)) {
                        violations.add("resume did not lead with a keyframe: " + t + " at seq " + seq);
                    }
                    resumeSeqJump = false;
                    lastSeq = seq;
                } else if (resumeTail && seq <= lastSeq
                        && ("game.log".equals(t) || "game.over".equals(t))) {
                    backfillLogs++;
                    if ("game.log".equals(t) && "chat".equals(n.path("kind").asText())) {
                        chatLines.add(n.path("text").asText());
                    }
                    return;
                } else {
                    if (seq != lastSeq + 1) {
                        violations.add("seq gap: " + lastSeq + " -> " + seq + " on " + t);
                    }
                    lastSeq = seq;
                    if (resumeTail && !("game.prompt".equals(t) && resumePromptRedelivery)) {
                        // a fresh event past the redelivered prompt — the burst is over
                        resumeTail = false;
                        resumePromptRedelivery = false;
                    }
                }
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
                    if (n.path("combat").isObject()) {
                        combatPrompts++;
                        if (!n.path("playable").isEmpty()) {
                            violations.add("combat prompt " + n.path("promptId").asLong()
                                    + " carries a non-empty playable map (§8: not a cast window)");
                        }
                    }
                    long id = n.path("promptId").asLong();
                    if (pendingPromptId != null && !resumePromptRedelivery) {
                        violations.add("prompt " + id + " arrived while "
                                + pendingPromptId + " still pending");
                    }
                    // §14: right after a resume the pending prompt returns under its
                    // old promptId; a different id means it resolved while we were away
                    resumePromptRedelivery = false;
                    pendingPromptId = id;
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
                case "game.log" -> {
                    logLines++;
                    if ("chat".equals(n.path("kind").asText())) {
                        chatLines.add(n.path("text").asText());
                    }
                }
                case "game.over" -> gameOver = n;
                default -> {
                }
            }
        }

        boolean sawChatContaining(String needle) {
            return chatLines.stream().anyMatch(l -> l.contains(needle));
        }

        long chatCountContaining(String needle) {
            return chatLines.stream().filter(l -> l.contains(needle)).count();
        }
    }

    // ---- minimal blocking WS client ----

    static final class Client implements WebSocket.Listener {
        final BlockingQueue<String> frames = new LinkedBlockingQueue<>();
        /** Prompts pulled mid-await (e.g. racing a resync keyframe) — must be answered, not dropped. */
        final ArrayDeque<JsonNode> stash = new ArrayDeque<>();
        final StringBuilder partial = new StringBuilder();
        /** Shared across reconnects of one session: command ids must never repeat
         * under a token, or the §14 idempotency window replays stale replies. */
        final AtomicInteger cmdIds;
        final Auditor auditor;
        final String label;
        String token;                     // from the fresh welcome; carried across reconnects
        WebSocket ws;

        private Client(String label, Auditor auditor, AtomicInteger cmdIds) {
            this.label = label;
            this.auditor = auditor;
            this.cmdIds = cmdIds;
        }

        static Client connect(int port, String label) {
            return open(port, new Client(label, new Auditor(), new AtomicInteger()));
        }

        /** A new socket continuing this session: same auditor, ids, and token. */
        Client reconnect(int port) {
            Client next = new Client(label, auditor, cmdIds);
            next.token = token;
            return open(port, next);
        }

        /** Hard drop, as a browser refresh would: no close frame niceties. */
        void drop() {
            ws.abort();
        }

        private static Client open(int port, Client c) {
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
            System.out.println("[live " + label + "] WS ERROR: " + error);
            error.printStackTrace(System.out);
        }

        @Override
        public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
            System.out.println("[live " + label + "] WS CLOSED " + statusCode + " '" + reason + "'");
            return null;
        }

        String send(String type, Map<String, Object> fields) {
            String id = "c" + cmdIds.incrementAndGet();
            sendWithId(type, id, fields);
            return id;
        }

        /** Verbatim re-send for idempotency probes — same id, same fields. */
        void sendWithId(String type, String id, Map<String, Object> fields) {
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
        }

        /** Pulls frames (auditing each) until one matches; fails on timeout. */
        JsonNode await(String what, long timeoutSecs, Predicate<JsonNode> matcher) throws Exception {
            return awaitFrame(what, timeoutSecs, matcher, true);
        }

        /** Like await, but expected errors (bumps, teardown) are data, not failures. */
        JsonNode awaitAllowingErrors(String what, long timeoutSecs, Predicate<JsonNode> matcher)
                throws Exception {
            return awaitFrame(what, timeoutSecs, matcher, false);
        }

        private JsonNode awaitFrame(String what, long timeoutSecs, Predicate<JsonNode> matcher,
                                    boolean failOnErrorFrames) throws Exception {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSecs);
            while (true) {
                long waitNanos = deadline - System.nanoTime();
                if (waitNanos <= 0) {
                    fail("[" + label + "] timed out waiting for " + what);
                }
                String frame = frames.poll(Math.min(waitNanos, TimeUnit.SECONDS.toNanos(5)),
                        TimeUnit.NANOSECONDS);
                if (frame == null) {
                    continue;
                }
                JsonNode n = json.readTree(frame);
                auditor.observe(n, frame.length());
                if (failOnErrorFrames && "error".equals(n.path("t").asText())
                        && !"PROMPT_STALE".equals(n.path("code").asText())) {
                    fail("[" + label + "] unexpected error frame: " + frame);
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

        /** session.hello; fresh (no token) captures welcome.token. */
        JsonNode hello(Map<String, Object> extra) throws Exception {
            String id = send("session.hello", withV(extra));
            JsonNode welcome = await("welcome", 10,
                    n -> "session.welcome".equals(n.path("t").asText())
                            && id.equals(n.path("re").asText()));
            if (welcome.hasNonNull("token")) {
                token = welcome.get("token").asText();
            }
            return welcome;
        }

        private Map<String, Object> withV(Map<String, Object> extra) {
            var m = new java.util.HashMap<String, Object>();
            m.put("v", 1);
            m.putAll(extra);
            return m;
        }
    }

    // ---- the auto-player (M3's, unchanged): finishes a real game ----

    /**
     * Keep hands, play lands, try casting each castable once <em>per
     * land-count level</em> (a cast that aborted at 2 lands gets another shot
     * once more mana is down — try-once-ever left seats creatureless for whole
     * games; still convergent, since lands are finite and a failed retry just
     * re-skips until the count grows), attack with one creature per combat,
     * submit required selections whole-set ({@code objects}) to exercise the
     * §8 replay live; everything else answers first-option/minimum.
     */
    static void autoAnswer(Client c, JsonNode prompt, Map<String, Integer> repeats) {
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
            case "priority" -> {
                JsonNode combat = prompt.path("combat");
                if (combat.isObject()) {
                    JsonNode candidates = combat.path("candidates");
                    boolean attacking = "attackers".equals(combat.path("role").asText());
                    // one attacker per combat; capped in case an attack cost reverts the
                    // toggle (declared back to 0 would otherwise re-toggle forever)
                    if (attacking && candidates.size() > 0 && combat.path("declared").isEmpty()
                            && repeats.merge("combatToggles", 1, Integer::sum) <= 20) {
                        answer.put("type", "object").put("objectId", candidates.get(0).asText());
                    } else {
                        answer.put("type", "confirm").put("value", true);   // done declaring
                    }
                } else {
                    // lands first (free mana growth), then creature casts (the path
                    // to combat), then anything else castable — each object tried
                    // once per land-count level (see method doc)
                    String landLevel = "|L" + myLandCount(c);
                    String land = null;
                    String creature = null;
                    String other = null;
                    for (var e : prompt.path("playable").properties()) {
                        boolean play = false;
                        boolean cast = false;
                        for (JsonNode a : e.getValue()) {
                            play |= "play".equals(a.path("kind").asText());
                            cast |= "cast".equals(a.path("kind").asText());
                        }
                        if (!play && !cast) {
                            continue;
                        }
                        String id = e.getKey();
                        if (repeats.getOrDefault("tried|" + id + landLevel, 0) > 0) {
                            continue;
                        }
                        if (play && land == null) {
                            land = id;
                        } else if (cast && creature == null && isCreatureInHand(c, id)) {
                            creature = id;
                        } else if (cast && other == null) {
                            other = id;
                        }
                    }
                    String act = land != null ? land : creature != null ? creature : other;
                    if (act != null) {
                        repeats.merge("tried|" + act + landLevel, 1, Integer::sum);
                        answer.put("type", "object").put("objectId", act);
                    } else {
                        answer.put("type", "confirm").put("value", false);
                    }
                }
            }
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
            case "payMana" -> {
                // pay it: one source click per round trip (§8's payMana shape) —
                // sources may include objects that can't contribute to the remaining
                // cost (XMage re-asks identically), so rotate through the sources and
                // cancel once each has had a try; progress resets the counter because
                // the shrunk remaining cost changes the message
                JsonNode sources = prompt.path("sources");
                int attempt = repeats.merge("pay|" + message, 1, Integer::sum);
                if (sources.isArray() && sources.size() > 0 && attempt <= sources.size()) {
                    answer.put("type", "object")
                            .put("objectId", sources.get((attempt - 1) % sources.size()).asText());
                } else {
                    answer.put("type", "cancel");
                }
            }
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
        System.out.printf("[live %s] prompt #%d %s '%.60s' -> %s%n",
                c.label, promptId, kind, message, answer);
        c.send("game.answer", Map.of("gameId", gameId, "promptId", promptId, "answer", answer));
    }

    /** My battlefield land count — the auto-player's "mana grew, retry casts" level. */
    private static int myLandCount(Client c) {
        JsonNode state = c.auditor.applied;
        if (state == null) {
            return 0;
        }
        String me = state.path("me").path("playerId").asText();
        for (JsonNode p : state.path("players")) {
            if (!me.equals(p.path("id").asText())) {
                continue;
            }
            int lands = 0;
            for (JsonNode perm : p.path("battlefield")) {
                for (JsonNode type : perm.path("types")) {
                    if ("LAND".equals(type.asText())) {
                        lands++;
                        break;
                    }
                }
            }
            return lands;
        }
        return 0;
    }

    /** Card-type lookup in the patch-maintained state tree (me.hand carries full views). */
    private static boolean isCreatureInHand(Client c, String objectId) {
        JsonNode state = c.auditor.applied;
        if (state == null) {
            return false;
        }
        for (JsonNode card : state.path("me").path("hand")) {
            if (objectId.equals(card.path("id").asText())) {
                for (JsonNode type : card.path("types")) {
                    if ("CREATURE".equals(type.asText())) {
                        return true;
                    }
                }
            }
        }
        return false;
    }
}
