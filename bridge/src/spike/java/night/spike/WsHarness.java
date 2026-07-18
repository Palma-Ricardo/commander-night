package night.spike;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.flipkart.zjsonpatch.JsonPatch;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The raw-WS harness a human plays bridge games through. Not part of the
 * bridge daemon — a terminal client for protocol v1 with just enough
 * rendering and shorthand to be playable:
 *
 * <pre>
 *   mvn -Pharness compile exec:exec                  # bridge on 127.0.0.1:8484
 *   (args: [url] [--keyframes]  — --keyframes asks for §7 keyframes-only sync)
 *
 *   create                        make a lobby (code arrives in lobby.state)
 *   join CODE Name                take a seat
 *   deck path/to/deck.dck         submit a deck
 *   ready | start                 ready up; start with AI fill
 *   p                             pass priority
 *   y / n                         answer a confirm
 *   1..n                          pick the numbered candidate/option
 *                                 (on a chooseAmount prompt: the number itself;
 *                                 on a combat ask: toggle the creature, done to finish)
 *   take 1 3 4                    submit several numbered candidates at once
 *   split 3 1 0                   distribute amounts, one per numbered row
 *   pile 1 | pile 2               choose a pile
 *   done | cancel                 finish / decline a selection
 *   mana W|U|B|R|G|C              pay from pool
 *   chat TEXT                     say it in game chat
 *   resync                        ask for a fresh keyframe
 *   reconnect                     drop the socket and resume the session (§14)
 *   concede | skip MODE | automana on|off | triggers
 *                                 game.action (MODE: stack|eot|main|myturn|endstep|cancel)
 *   { ... }                       send raw JSON verbatim
 * </pre>
 *
 * The session (token, gameId, last seq) persists in {@code .harness-session.json}
 * so a killed harness resumes its seat on restart — the M4 refresh flow, in a
 * terminal. {@code --fresh} ignores the saved session.
 */
public final class WsHarness implements WebSocket.Listener {

    private static final ObjectMapper json = new ObjectMapper();
    private static final Path SESSION_FILE = Path.of(".harness-session.json");

    private final AtomicInteger ids = new AtomicInteger();
    /** Command ids must be unique across runs of one token (§3) — a restarted
     * plain counter would replay stale recorded replies out of the §14 window. */
    private final String idNonce = Long.toHexString(System.nanoTime() & 0xffffff);
    private final StringBuilder partial = new StringBuilder();
    private final boolean keyframesOnly;
    private final String url;
    private WebSocket ws;

    // rendered state (main-thread reads are racy but this is a dev tool)
    private volatile JsonNode lastState;
    private volatile long lastAppliedSeq = -1;
    private volatile long lastSeenSeq = -1;
    private volatile JsonNode pendingPrompt;
    private volatile String gameId;
    private volatile String token;

    /** One numbered line the user can pick: the wire value + its answer type. */
    private record Numbered(String value, String answerType) {
    }

    private final List<Numbered> numbered = new ArrayList<>();

    private WsHarness(boolean keyframesOnly, String url) {
        this.keyframesOnly = keyframesOnly;
        this.url = url;
    }

    public static void main(String[] args) throws Exception {
        String url = "ws://127.0.0.1:8484/ws";
        boolean keyframes = false;
        boolean fresh = false;
        for (String arg : args) {
            switch (arg) {
                case "--keyframes" -> keyframes = true;
                case "--fresh" -> fresh = true;
                default -> url = arg;
            }
        }
        WsHarness harness = new WsHarness(keyframes, url);
        if (!fresh) {
            harness.loadSession();
        }
        harness.dial();

        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
        String line;
        while ((line = in.readLine()) != null) {
            try {
                if (!harness.handleInput(line.strip())) {
                    break;
                }
            } catch (Exception e) {
                System.out.println("! " + e);
            }
        }
        harness.ws.sendClose(WebSocket.NORMAL_CLOSURE, "bye").join();
    }

    /** Connect (or re-connect) and hello — with token + resume when we have them (§14). */
    private void dial() {
        ws = HttpClient.newHttpClient().newWebSocketBuilder()
                .buildAsync(URI.create(url), this).join();
        System.out.println("* connected to " + url + (keyframesOnly ? " (keyframes-only)" : "")
                + (token != null ? " (saved session)" : "") + " — type 'help' for commands");
        send("session.hello", n -> {
            n.put("v", 1);
            if (keyframesOnly) {
                n.put("stateMode", "keyframes");
            }
            if (token != null) {
                n.put("token", token);
                if (gameId != null) {
                    n.putObject("resume").put("gameId", gameId).put("lastSeq", lastSeenSeq);
                }
            }
        });
    }

    // ---- session persistence: survive a harness kill like a browser refresh ----

    private void loadSession() {
        try {
            if (Files.exists(SESSION_FILE)) {
                JsonNode s = json.readTree(Files.readString(SESSION_FILE));
                token = s.hasNonNull("token") ? s.get("token").asText() : null;
                gameId = s.hasNonNull("gameId") ? s.get("gameId").asText() : null;
                lastSeenSeq = s.path("lastSeq").asLong(-1);
            }
        } catch (Exception e) {
            System.out.println("! could not read " + SESSION_FILE + ": " + e);
        }
    }

    private void saveSession() {
        try {
            ObjectNode s = json.createObjectNode();
            if (token != null) {
                s.put("token", token);
            }
            if (gameId != null) {
                s.put("gameId", gameId).put("lastSeq", lastSeenSeq);
            }
            Files.writeString(SESSION_FILE, s.toString());
        } catch (Exception e) {
            System.out.println("! could not write " + SESSION_FILE + ": " + e);
        }
    }

    private boolean handleInput(String line) throws Exception {
        if (line.isEmpty()) {
            return true;
        }
        String[] words = line.split("\\s+");
        switch (words[0].toLowerCase()) {
            case "quit", "exit" -> {
                return false;
            }
            case "help" -> System.out.println("""
                    create | join CODE NAME | deck FILE | ready | start
                    p(ass) | y | n | 1..9 | take N N.. | split N N.. | pile 1|2
                    done | cancel | mana W|U|B|R|G|C
                    chat TEXT | resync | reconnect
                    concede | skip stack|eot|main|myturn|endstep|cancel
                    automana on|off | triggers | raw {json}""");
            case "create" -> send("lobby.create", n -> n.put("format", "commander-ffa"));
            case "join" -> send("lobby.join", n -> n.put("code", words[1])
                    .put("displayName", line.substring(line.indexOf(words[1]) + words[1].length()).strip()));
            case "deck" -> {
                String content = Files.readString(Path.of(line.substring(5).strip()));
                send("lobby.deck", n -> n.put("format", "dck").put("content", content));
            }
            case "ready" -> send("lobby.ready", n -> n.put("ready", true));
            case "start" -> send("lobby.start", n -> n.put("fillAI", true));
            case "p", "pass", "n" -> answer(a -> a.put("type", "confirm").put("value", false));
            case "y", "yes" -> answer(a -> a.put("type", "confirm").put("value", true));
            case "done" -> answer(a -> a.put("type", "confirm").put("value", true));
            case "cancel" -> answer(a -> a.put("type", "cancel"));
            case "mana" -> answer(a -> a.put("type", "mana").put("color", words[1].toUpperCase()));
            case "pile" -> answer(a -> a.put("type", "pile").put("index", Integer.parseInt(words[1]) - 1));
            case "take" -> {
                List<String> picked = resolveNumbered(words);
                if (picked != null) {
                    answer(a -> {
                        a.put("type", "objects");
                        var arr = a.putArray("objectIds");
                        picked.forEach(arr::add);
                    });
                }
            }
            case "split" -> {
                JsonNode prompt = pendingPrompt;
                if (prompt == null || !"distribute".equals(prompt.path("kind").asText())) {
                    System.out.println("! no distribute prompt pending");
                    return true;
                }
                JsonNode among = prompt.path("among");
                if (words.length - 1 != among.size()) {
                    System.out.println("! need exactly " + among.size() + " amounts");
                    return true;
                }
                answer(a -> {
                    a.put("type", "distribution");
                    var arr = a.putArray("amounts");
                    for (int i = 1; i < words.length; i++) {
                        arr.addObject().put("id", among.get(i - 1).path("id").asText())
                                .put("amount", Long.parseLong(words[i]));
                    }
                });
            }
            case "chat" -> {
                if (gameId == null) {
                    System.out.println("! no game yet");
                } else {
                    String text = line.length() > 5 ? line.substring(5).strip() : "";
                    send("chat.send", n -> n.put("gameId", gameId).put("text", text));
                }
            }
            case "resync" -> send("game.resync", n -> n.put("gameId", gameId));
            case "reconnect" -> {
                ws.abort();
                pendingPrompt = null;
                dial();
            }
            case "concede" -> action(a -> a.put("kind", "concede"));
            case "skip" -> {
                String mode = switch (words.length > 1 ? words[1] : "") {
                    case "stack" -> "stack";
                    case "eot" -> "endOfTurn";
                    case "main" -> "nextMain";
                    case "myturn" -> "myNextTurn";
                    case "endstep" -> "endStepBeforeMyTurn";
                    case "cancel" -> "cancel";
                    default -> null;
                };
                if (mode == null) {
                    System.out.println("! skip stack|eot|main|myturn|endstep|cancel");
                } else {
                    String m = mode;
                    action(a -> a.put("kind", "skip").put("mode", m));
                }
            }
            case "automana" -> action(a -> a.put("kind", "autoMana")
                    .put("enabled", "on".equalsIgnoreCase(words.length > 1 ? words[1] : "on")));
            case "triggers" -> action(a -> a.put("kind", "triggerOrder").put("mode", "reset"));
            default -> {
                if (line.startsWith("{")) {
                    ws.sendText(line, true).join();
                } else if (words[0].matches("\\d+")) {
                    bareNumber(words[0]);
                } else {
                    System.out.println("! unknown command (try 'help')");
                }
            }
        }
        return true;
    }

    /** A bare number answers a chooseAmount, or picks the numbered line. */
    private void bareNumber(String word) {
        JsonNode prompt = pendingPrompt;
        if (prompt != null && "chooseAmount".equals(prompt.path("kind").asText())) {
            answer(a -> a.put("type", "number").put("value", Long.parseLong(word)));
            return;
        }
        int i = Integer.parseInt(word) - 1;
        if (i < 0 || i >= numbered.size()) {
            System.out.println("! no option " + word);
            return;
        }
        Numbered pick = numbered.get(i);
        answer(a -> {
            switch (pick.answerType()) {
                case "option" -> a.put("type", "option").put("key", pick.value());
                default -> a.put("type", "object").put("objectId", pick.value());
            }
        });
    }

    private List<String> resolveNumbered(String[] words) {
        List<String> out = new ArrayList<>();
        for (int w = 1; w < words.length; w++) {
            int i = Integer.parseInt(words[w]) - 1;
            if (i < 0 || i >= numbered.size()) {
                System.out.println("! no option " + words[w]);
                return null;
            }
            out.add(numbered.get(i).value());
        }
        return out.isEmpty() ? null : out;
    }

    private void answer(java.util.function.Consumer<ObjectNode> fill) {
        JsonNode prompt = pendingPrompt;
        if (prompt == null) {
            System.out.println("! no prompt pending");
            return;
        }
        ObjectNode a = json.createObjectNode();
        fill.accept(a);
        send("game.answer", n -> {
            n.put("gameId", gameId).put("promptId", prompt.path("promptId").asLong());
            n.set("answer", a);
        });
    }

    private void action(java.util.function.Consumer<ObjectNode> fill) {
        if (gameId == null) {
            System.out.println("! no game yet");
            return;
        }
        ObjectNode a = json.createObjectNode();
        fill.accept(a);
        send("game.action", n -> {
            n.put("gameId", gameId);
            n.set("action", a);
        });
    }

    private void send(String type, java.util.function.Consumer<ObjectNode> fill) {
        ObjectNode n = json.createObjectNode().put("t", type)
                .put("id", "h" + idNonce + "-" + ids.incrementAndGet());
        fill.accept(n);
        ws.sendText(n.toString(), true).join();
    }

    // ---- rendering ----

    @Override
    public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
        partial.append(data);
        if (last) {
            try {
                render(json.readTree(partial.toString()));
            } catch (Exception e) {
                System.out.println("! render failed: " + e);
            }
            partial.setLength(0);
        }
        ws.request(1);
        return null;
    }

    private void render(JsonNode n) {
        if (n.path("t").asText().startsWith("game.") && n.has("seq")) {
            lastSeenSeq = Math.max(lastSeenSeq, n.get("seq").asLong());
        }
        switch (n.path("t").asText()) {
            case "session.welcome" -> {
                if (n.hasNonNull("token")) {
                    token = n.get("token").asText();
                }
                saveSession();
                System.out.println("* session " + (n.path("resumed").asBoolean() ? "RESUMED" : "up")
                        + " (userId " + n.path("userId").asText().substring(0, 8) + "…)");
            }
            case "ack" -> {
            }
            case "error" -> {
                System.out.println("! error " + n.path("code").asText()
                        + ": " + n.path("message").asText());
                if ("RESUME_FAILED".equals(n.path("code").asText())) {
                    // §16.6 fallback: fresh hello on the same socket; the seat comes
                    // back via 'join CODE NAME' (displayName re-bind) if the game lives
                    gameId = null;
                    lastSeenSeq = -1;
                    saveSession();
                    send("session.hello", h -> {
                        h.put("v", 1);
                        if (token != null) {
                            h.put("token", token);
                        }
                    });
                }
            }
            case "lobby.state" -> {
                StringBuilder sb = new StringBuilder("* lobby " + n.path("code").asText() + ":");
                for (JsonNode seat : n.path("seats")) {
                    sb.append(" [").append(seat.path("name").asText());
                    JsonNode deck = seat.path("deck");
                    if (!deck.isMissingNode() && !deck.isNull()) {
                        sb.append(deck.path("valid").asBoolean() ? " ✓deck" : " ✗deck");
                    }
                    sb.append(seat.path("ready").asBoolean() ? " ready" : "").append(']');
                }
                System.out.println(sb);
            }
            case "game.state" -> {
                lastState = n.path("state");
                lastAppliedSeq = n.path("seq").asLong();
                gameId = n.path("gameId").asText();
                saveSession();
                System.out.println(stateLine(lastState));
            }
            case "game.patch" -> {
                long base = n.path("base").asLong();
                if (base != lastAppliedSeq) {
                    System.out.println("! patch base " + base + " ≠ applied " + lastAppliedSeq
                            + " — resyncing");
                    send("game.resync", r -> r.put("gameId", n.path("gameId").asText()));
                    return;
                }
                try {
                    lastState = JsonPatch.apply(n.path("ops"), lastState);
                    lastAppliedSeq = n.path("seq").asLong();
                    saveSession();
                    System.out.println(stateLine(lastState));
                } catch (Exception e) {
                    System.out.println("! patch failed to apply (" + e.getMessage() + ") — resyncing");
                    send("game.resync", r -> r.put("gameId", n.path("gameId").asText()));
                }
            }
            case "game.log" -> System.out.println("  |"
                    + ("chat".equals(n.path("kind").asText()) ? " [chat]" : "")
                    + " " + n.path("text").asText());
            case "game.prompt" -> {
                pendingPrompt = n;
                System.out.println(promptBlock(n));
            }
            case "game.promptDone" -> pendingPrompt = null;
            case "game.over" -> {
                saveSession();
                System.out.println("*** GAME OVER: " + n.path("reason").asText());
            }
            default -> System.out.println("* " + n.path("t").asText());
        }
    }

    private String stateLine(JsonNode s) {
        StringBuilder sb = new StringBuilder("== T").append(s.path("turn").path("n").asInt())
                .append(' ').append(s.path("turn").path("step").asText()).append(" |");
        for (JsonNode p : s.path("players")) {
            sb.append(' ').append(p.path("name").asText()).append(':')
                    .append(p.path("life").asInt())
                    .append("(bf").append(p.path("battlefield").size())
                    .append(",h").append(p.path("handSize").asInt()).append(')');
        }
        int stack = s.path("stack").size();
        if (stack > 0) {
            sb.append(" | stack:").append(stack).append('!');
        }
        return sb.toString();
    }

    private String promptBlock(JsonNode p) {
        numbered.clear();
        StringBuilder sb = new StringBuilder(">>> [").append(p.path("kind").asText()).append("] ")
                .append(p.path("message").asText());
        switch (p.path("kind").asText()) {
            case "priority" -> {
                JsonNode combat = p.path("combat");
                if (combat.isObject()) {
                    for (JsonNode c : combat.path("candidates")) {
                        numbered.add(new Numbered(c.asText(), "object"));
                        sb.append("\n  ").append(numbered.size()).append(") ").append(nameOf(c.asText()));
                    }
                    for (JsonNode c : combat.path("declared")) {
                        numbered.add(new Numbered(c.asText(), "object"));
                        sb.append("\n  ").append(numbered.size()).append(") ").append(nameOf(c.asText()))
                                .append("  — in combat, pick to withdraw");
                    }
                    if (combat.hasNonNull("special")) {
                        numbered.add(new Numbered("special", "option"));
                        sb.append("\n  ").append(numbered.size()).append(") [")
                                .append(combat.path("special").asText()).append(']');
                    }
                    sb.append("\n  N toggles a creature; done (or p) finishes declaring");
                } else {
                    p.path("playable").properties().forEach(e -> {
                        numbered.add(new Numbered(e.getKey(), "object"));
                        sb.append("\n  ").append(numbered.size()).append(") ").append(nameOf(e.getKey()));
                        List<String> texts = new ArrayList<>();
                        e.getValue().forEach(a -> texts.add(a.path("text").asText()));
                        sb.append("  — ").append(String.join(" / ", texts));
                    });
                    sb.append("\n  p) pass");
                }
            }
            case "chooseTargets" -> {
                for (JsonNode c : p.path("candidates")) {
                    numbered.add(new Numbered(c.asText(), "object"));
                    sb.append("\n  ").append(numbered.size()).append(") ").append(nameOf(c.asText()));
                }
                if (p.path("cards").isArray()) {
                    // names for candidates that aren't in visible state
                    for (JsonNode card : p.path("cards")) {
                        int i = indexOfNumbered(card.path("id").asText());
                        if (i >= 0) {
                            sb.append("\n      (").append(i + 1).append(" = ")
                                    .append(card.path("name").asText()).append(')');
                        }
                    }
                }
                sb.append("\n  N / take N N.. / done / cancel as allowed");
            }
            case "payMana" -> {
                for (JsonNode s : p.path("sources")) {
                    numbered.add(new Numbered(s.asText(), "object"));
                    sb.append("\n  ").append(numbered.size()).append(") ").append(nameOf(s.asText()));
                }
                sb.append("\n  or: mana W|U|B|R|G|C, cancel");
            }
            case "confirm" -> sb.append("  (y = ").append(p.path("yesText").asText("Yes"))
                    .append(", n = ").append(p.path("noText").asText("No")).append(')');
            case "chooseAbility" -> {
                for (JsonNode o : p.path("options")) {
                    numbered.add(new Numbered(o.path("id").asText(), "object"));
                    sb.append("\n  ").append(numbered.size()).append(") ").append(o.path("text").asText());
                }
            }
            case "chooseOption", "playerRequest" -> {
                for (JsonNode o : p.path("options")) {
                    numbered.add(new Numbered(o.path("key").asText(), "option"));
                    sb.append("\n  ").append(numbered.size()).append(") ").append(o.path("text").asText());
                }
                if ("chooseOption".equals(p.path("kind").asText())
                        && !p.path("required").asBoolean(true)) {
                    sb.append("\n  (cancel allowed)");
                }
            }
            case "choosePile" -> {
                for (int pile = 0; pile < p.path("piles").size(); pile++) {
                    sb.append("\n  pile ").append(pile + 1).append(':');
                    for (JsonNode card : p.path("piles").get(pile)) {
                        sb.append(' ').append(card.path("name").asText()).append(';');
                    }
                }
                sb.append("\n  answer: pile 1 | pile 2");
            }
            case "chooseAmount" -> sb.append("\n  type a number (")
                    .append(p.path("min").asLong()).append("–").append(p.path("max").asLong()).append(')');
            case "distribute" -> {
                for (JsonNode row : p.path("among")) {
                    numbered.add(new Numbered(row.path("id").asText(), "object"));
                    sb.append("\n  ").append(numbered.size()).append(") ").append(row.path("label").asText());
                    if (row.has("suggested")) {
                        sb.append(" (suggested ").append(row.path("suggested").asInt()).append(')');
                    }
                }
                sb.append("\n  answer: split N N.. (one per row, total ")
                        .append(p.path("min").asLong()).append("–").append(p.path("total").asLong()).append(')');
            }
            default -> {
            }
        }
        return sb.toString();
    }

    private int indexOfNumbered(String value) {
        for (int i = 0; i < numbered.size(); i++) {
            if (numbered.get(i).value().equals(value)) {
                return i;
            }
        }
        return -1;
    }

    /** Resolve an object id to a card name via the last keyframe. */
    private String nameOf(String id) {
        JsonNode s = lastState;
        if (s == null) {
            return id;
        }
        for (JsonNode card : s.path("me").path("hand")) {
            if (id.equals(card.path("id").asText())) {
                return card.path("name").asText() + " (hand)";
            }
        }
        for (JsonNode p : s.path("players")) {
            for (JsonNode perm : p.path("battlefield")) {
                if (id.equals(perm.path("id").asText())) {
                    return perm.path("name").asText();
                }
            }
            for (JsonNode c : p.path("commandZone")) {
                if (id.equals(c.path("id").asText())) {
                    return c.path("name").asText() + " (command)";
                }
            }
        }
        for (JsonNode item : s.path("stack")) {
            if (id.equals(item.path("id").asText())) {
                return item.path("card").path("name").asText() + " (stack)";
            }
        }
        return id.substring(0, 8) + "…";
    }
}
