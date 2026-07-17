package night.spike;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

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
 * The raw-WS harness a human plays M2 games through (design §14, M2 exit
 * criterion). Not part of the bridge daemon — a terminal client for protocol
 * v1 with just enough rendering and shorthand to be playable:
 *
 * <pre>
 *   mvn -Pharness compile exec:exec                  # bridge on 127.0.0.1:8484
 *
 *   create                        make a lobby (code arrives in lobby.state)
 *   join CODE Name                take a seat
 *   deck path/to/deck.dck         submit a deck
 *   ready | start                 ready up; start with AI fill
 *   p                             pass priority
 *   y / n                         answer a confirm
 *   1..n                          pick the numbered candidate / playable object
 *   done | cancel                 finish / decline a selection
 *   mana W|U|B|R|G|C              pay from pool
 *   { ... }                       send raw JSON verbatim
 * </pre>
 */
public final class WsHarness implements WebSocket.Listener {

    private static final ObjectMapper json = new ObjectMapper();

    private final AtomicInteger ids = new AtomicInteger();
    private final StringBuilder partial = new StringBuilder();
    private WebSocket ws;

    // rendered state (main-thread reads are racy but this is a dev tool)
    private volatile JsonNode lastState;
    private volatile JsonNode pendingPrompt;
    private volatile String gameId;
    private final List<String> numbered = new ArrayList<>();

    public static void main(String[] args) throws Exception {
        String url = args.length > 0 ? args[0] : "ws://127.0.0.1:8484/ws";
        WsHarness harness = new WsHarness();
        harness.ws = HttpClient.newHttpClient().newWebSocketBuilder()
                .buildAsync(URI.create(url), harness).join();
        System.out.println("* connected to " + url + " — type 'help' for commands");
        harness.send("session.hello", n -> n.put("v", 1));

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
                    p(ass) | y | n | 1..9 | done | cancel | mana W|U|B|R|G|C | raw {json}""");
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
            default -> {
                if (line.startsWith("{")) {
                    ws.sendText(line, true).join();
                } else if (words[0].matches("\\d+")) {
                    int i = Integer.parseInt(words[0]) - 1;
                    if (i < 0 || i >= numbered.size()) {
                        System.out.println("! no option " + words[0]);
                    } else {
                        String objectId = numbered.get(i);
                        answer(a -> a.put("type", "object").put("objectId", objectId));
                    }
                } else {
                    System.out.println("! unknown command (try 'help')");
                }
            }
        }
        return true;
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
                gameId = n.path("gameId").asText();
                System.out.println(stateLine(lastState));
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
                    numbered.add(e.getKey());
                    sb.append("\n  ").append(numbered.size()).append(") ").append(nameOf(e.getKey()));
                    List<String> texts = new ArrayList<>();
                    e.getValue().forEach(a -> texts.add(a.path("text").asText()));
                    sb.append("  — ").append(String.join(" / ", texts));
                });
                sb.append("\n  p) pass");
            }
            case "chooseTargets" -> {
                for (JsonNode c : p.path("candidates")) {
                    numbered.add(c.asText());
                    sb.append("\n  ").append(numbered.size()).append(") ").append(nameOf(c.asText()));
                }
                if (p.path("cards").isArray()) {
                    // names for candidates that aren't in visible state
                    for (JsonNode card : p.path("cards")) {
                        int i = numbered.indexOf(card.path("id").asText());
                        if (i >= 0) {
                            sb.append("\n      (").append(i + 1).append(" = ")
                                    .append(card.path("name").asText()).append(')');
                        }
                    }
                }
                sb.append("\n  done/cancel as allowed");
            }
            case "payMana" -> {
                for (JsonNode s : p.path("sources")) {
                    numbered.add(s.asText());
                    sb.append("\n  ").append(numbered.size()).append(") ").append(nameOf(s.asText()));
                }
                sb.append("\n  or: mana W|U|B|R|G|C, cancel");
            }
            case "confirm" -> sb.append("  (y = ").append(p.path("yesText").asText("Yes"))
                    .append(", n = ").append(p.path("noText").asText("No")).append(')');
            default -> {
            }
        }
        return sb.toString();
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
