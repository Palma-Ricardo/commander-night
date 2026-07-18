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
 *                                 (on a chooseAmount prompt: the number itself)
 *   take 1 3 4                    submit several numbered candidates at once
 *   split 3 1 0                   distribute amounts, one per numbered row
 *   pile 1 | pile 2               choose a pile
 *   done | cancel                 finish / decline a selection
 *   mana W|U|B|R|G|C              pay from pool
 *   resync                        ask for a fresh keyframe
 *   concede | skip MODE | automana on|off | triggers
 *                                 game.action (MODE: stack|eot|main|myturn|endstep|cancel)
 *   { ... }                       send raw JSON verbatim
 * </pre>
 */
public final class WsHarness implements WebSocket.Listener {

    private static final ObjectMapper json = new ObjectMapper();

    private final AtomicInteger ids = new AtomicInteger();
    private final StringBuilder partial = new StringBuilder();
    private final boolean keyframesOnly;
    private WebSocket ws;

    // rendered state (main-thread reads are racy but this is a dev tool)
    private volatile JsonNode lastState;
    private volatile long lastAppliedSeq = -1;
    private volatile JsonNode pendingPrompt;
    private volatile String gameId;

    /** One numbered line the user can pick: the wire value + its answer type. */
    private record Numbered(String value, String answerType) {
    }

    private final List<Numbered> numbered = new ArrayList<>();

    private WsHarness(boolean keyframesOnly) {
        this.keyframesOnly = keyframesOnly;
    }

    public static void main(String[] args) throws Exception {
        String url = "ws://127.0.0.1:8484/ws";
        boolean keyframes = false;
        for (String arg : args) {
            if ("--keyframes".equals(arg)) {
                keyframes = true;
            } else {
                url = arg;
            }
        }
        boolean keyframesMode = keyframes;
        WsHarness harness = new WsHarness(keyframesMode);
        harness.ws = HttpClient.newHttpClient().newWebSocketBuilder()
                .buildAsync(URI.create(url), harness).join();
        System.out.println("* connected to " + url + (keyframesMode ? " (keyframes-only)" : "")
                + " — type 'help' for commands");
        harness.send("session.hello", n -> {
            n.put("v", 1);
            if (keyframesMode) {
                n.put("stateMode", "keyframes");
            }
        });

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
                    resync | concede | skip stack|eot|main|myturn|endstep|cancel
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
            case "resync" -> send("game.resync", n -> n.put("gameId", gameId));
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
        ObjectNode n = json.createObjectNode().put("t", type).put("id", "c" + ids.incrementAndGet());
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
        switch (n.path("t").asText()) {
            case "session.welcome" -> System.out.println("* session up (userId "
                    + n.path("userId").asText().substring(0, 8) + "…)");
            case "ack" -> {
            }
            case "error" -> System.out.println("! error " + n.path("code").asText()
                    + ": " + n.path("message").asText());
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
                    System.out.println(stateLine(lastState));
                } catch (Exception e) {
                    System.out.println("! patch failed to apply (" + e.getMessage() + ") — resyncing");
                    send("game.resync", r -> r.put("gameId", n.path("gameId").asText()));
                }
            }
            case "game.log" -> System.out.println("  | " + n.path("text").asText());
            case "game.prompt" -> {
                pendingPrompt = n;
                System.out.println(promptBlock(n));
            }
            case "game.promptDone" -> pendingPrompt = null;
            case "game.over" -> System.out.println("*** GAME OVER: " + n.path("reason").asText());
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
                p.path("playable").properties().forEach(e -> {
                    numbered.add(new Numbered(e.getKey(), "object"));
                    sb.append("\n  ").append(numbered.size()).append(") ").append(nameOf(e.getKey()));
                    List<String> texts = new ArrayList<>();
                    e.getValue().forEach(a -> texts.add(a.path("text").asText()));
                    sb.append("  — ").append(String.join(" / ", texts));
                });
                sb.append("\n  p) pass");
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
