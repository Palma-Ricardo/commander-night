package night.bridge.live;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.javalin.Javalin;
import night.bridge.config.Config;
import night.bridge.game.Games;
import night.bridge.lobby.LobbyService;
import night.bridge.lobby.deck.Fixtures;
import night.bridge.live.LiveHarness.Client;
import night.bridge.net.Codec;
import night.bridge.net.SessionRegistry;
import night.bridge.net.WsEndpoint;
import night.bridge.xmage.XmageGateway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static night.bridge.live.LiveHarness.autoAnswer;
import static night.bridge.live.LiveHarness.json;
import static night.bridge.live.LiveHarness.xmageUp;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The M4 exit criterion as a test (design §14): two humans + two AIs play a
 * full game through the bridge while both browser sessions get abused the way
 * real friends' night will abuse them:
 *
 * <ul>
 *   <li><b>Mid-game refresh on both sides</b> — each seat hard-drops its
 *       socket while holding an unanswered prompt, resumes via
 *       {@code hello{token, resume}}, and must get {@code welcome
 *       resumed:true}, a fresh keyframe first, the pending prompt re-emitted
 *       under its <em>original</em> promptId, and log backfill (§14);</li>
 *   <li><b>Chat</b> — both seats {@code chat.send}; each must see the other's
 *       line come back as {@code game.log kind:chat};</li>
 *   <li><b>Idempotency</b> — a verbatim duplicate {@code chat.send} (same
 *       command id) is re-acked without re-executing: two acks, exactly one
 *       chat line on every seat (§14);</li>
 *   <li><b>Lost-token recovery</b> — a completely fresh session claims Bob's
 *       seat by displayName via {@code lobby.join} on the running game; the
 *       old socket is bumped, the new one gets the full resume sequence and
 *       finishes the game (§5/§16.6);</li>
 *   <li><b>game.over / rematch / teardown</b> — after game over: resume still
 *       replays final keyframe + game.over; a started lobby releases its
 *       members ({@code lobby.create} succeeds → rematch); after the
 *       post-game grace the game is gone (chat → UNKNOWN_GAME, resume →
 *       RESUME_FAILED).</li>
 * </ul>
 *
 * Requires a local XMage server on 17171 (skipped otherwise): {@code mvn -Plive test}.
 */
@Tag("live")
class MultiHumanLiveTest {

    /** Short grace so the test can watch teardown happen (design §6). */
    private static final int GRACE_SECS = 10;

    private static final String ALICE_CHAT = "ping from alice - m4 chat check";
    private static final String BOB_CHAT = "pong from bob - m4 chat check";

    @Test
    @Timeout(value = 30, unit = TimeUnit.MINUTES)
    void twoHumansWithRefreshesChatAndRecovery() throws Exception {
        assumeTrue(xmageUp(), "local XMage server on 17171 required (vendor/xmage-dist)");

        Config config = new Config("127.0.0.1:0", new Config.Xmage("127.0.0.1", 17171),
                100, new Config.LogBackfill(200, 50), false,
                "../vendor/xmage-dist/xmage/mage-client/sample-decks/Commander", GRACE_SECS);
        Games games = new Games();
        SessionRegistry registry = new SessionRegistry(games);
        XmageGateway gateway = new XmageGateway(config);
        LobbyService lobby = new LobbyService(registry, gateway, games, config);
        Javalin app = new WsEndpoint(new Codec(), registry, lobby, games, gateway::health).buildApp();
        app.start("127.0.0.1", 0);
        try {
            run(app.port());
        } finally {
            app.stop();
            lobby.close();
            gateway.close();
            registry.close();
        }
    }

    private void run(int port) throws Exception {
        // ---- lobby: Alice hosts, Bob joins, 2 AI fill ----
        Client alice = Client.connect(port, "alice");
        alice.hello(Map.of());
        assertNotNull(alice.token, "fresh hello must mint a token");

        alice.awaitAck("lobby.create", alice.send("lobby.create", Map.of("format", "commander-ffa")));
        String code = alice.await("lobby.state with code", 10,
                n -> "lobby.state".equals(n.path("t").asText()) && n.hasNonNull("code"))
                .get("code").asText();
        alice.awaitAck("join", alice.send("lobby.join", Map.of("code", code, "displayName", "Alice")));
        // Deck import acceptance (Task 15): the two NEW formats play a real game,
        // auto-detected. Alice pastes a Moxfield export whose two commanders are a
        // partner pair only the card database can identify (XMage's own
        // DoctorsCompanionValidator); Bob pastes an MTGO plain list whose single
        // commander rides a trailing blank-line-delimited stanza. Both go through
        // sniff → parse → assemble → the same lobby/joinTable/game/rematch path.
        String moxfield = Fixtures.read("timey_wimey.moxfield");
        String mtgo = Fixtures.read("counter_intelligence.mtgo");
        alice.awaitAck("deck", alice.send("lobby.deck", Map.of("format", "auto", "content", moxfield)));
        alice.awaitAck("ready", alice.send("lobby.ready", Map.of("ready", true)));

        Client bob = Client.connect(port, "bob");
        bob.hello(Map.of());
        bob.awaitAck("join", bob.send("lobby.join", Map.of("code", code, "displayName", "Bob")));
        bob.awaitAck("deck", bob.send("lobby.deck", Map.of("format", "auto", "content", mtgo)));

        // The lobby must show auto-detection worked and both parsers ran end to end,
        // otherwise the game below would still start and silently prove nothing about
        // import. Wait for the lobby.state that carries BOTH decks (seat 1 present),
        // then check each seat's echoed format, count and inferred commander(s).
        JsonNode decked = alice.await("lobby.state with both decks", 10,
                n -> "lobby.state".equals(n.path("t").asText())
                        && "mtgo".equals(n.at("/seats/1/deck/format").asText()));
        assertEquals("moxfield", decked.at("/seats/0/deck/format").asText(),
                "Alice's Moxfield export must be auto-detected");
        assertTrue(decked.at("/seats/0/deck/valid").asBoolean(false), "Alice's Moxfield deck must validate");
        assertEquals(100, decked.at("/seats/0/deck/cards").asInt(), "Alice's deck is a 100-card Commander deck");
        assertEquals(2, decked.at("/seats/0/deck/commander").size(),
                "Rose Tyler + The Tenth Doctor should be detected as a partner pair");
        assertEquals("Rose Tyler", decked.at("/seats/0/deck/commander/0").asText());
        assertEquals("The Tenth Doctor", decked.at("/seats/0/deck/commander/1").asText());
        assertTrue(decked.at("/seats/1/deck/valid").asBoolean(false), "Bob's MTGO deck must validate");
        assertEquals(100, decked.at("/seats/1/deck/cards").asInt(), "Bob's deck is a 100-card Commander deck");
        assertEquals(1, decked.at("/seats/1/deck/commander").size(),
                "counter_intelligence's single trailing-stanza commander must be detected");
        assertEquals("Inspirit, Flagship Vessel", decked.at("/seats/1/deck/commander/0").asText());

        bob.awaitAck("ready", bob.send("lobby.ready", Map.of("ready", true)));

        alice.awaitAck("start", alice.send("lobby.start", Map.of("fillAI", true)));

        // ---- both seats play concurrently, with scripted abuse ----
        AtomicReference<Client> aliceFinal = new AtomicReference<>(alice);
        AtomicReference<Client> bobFinal = new AtomicReference<>(bob);
        List<Throwable> failures = new ArrayList<>();
        Thread aliceThread = seatThread("alice-seat", failures, () ->
                playSeat(alice, port, code, aliceFinal, new SeatScript(4, ALICE_CHAT, 8, false)));
        Thread bobThread = seatThread("bob-seat", failures, () ->
                playSeat(bob, port, code, bobFinal, new SeatScript(6, BOB_CHAT, 12, true)));
        aliceThread.start();
        bobThread.start();
        aliceThread.join(TimeUnit.MINUTES.toMillis(27));
        bobThread.join(TimeUnit.MINUTES.toMillis(2));
        if (aliceThread.isAlive() || bobThread.isAlive()) {
            failures.add(new AssertionError("seat thread(s) still running at timeout"));
        }
        if (!failures.isEmpty()) {
            AssertionError e = new AssertionError("seat thread failed: " + failures);
            failures.forEach(e::addSuppressed);
            throw e;
        }

        Client a = aliceFinal.get();
        Client b = bobFinal.get();

        // ---- cross-seat assertions ----
        assertEquals(List.of(), a.auditor.violations, "alice invariant violations");
        assertEquals(List.of(), bob.auditor.violations, "bob (pre-recovery) invariant violations");
        assertEquals(List.of(), b.auditor.violations, "bob (post-recovery) invariant violations");

        assertNotNull(a.auditor.gameOver, "alice saw game.over");
        assertNotNull(b.auditor.gameOver, "bob saw game.over");
        assertEquals(a.auditor.gameOver.path("winnerPlayerIds"),
                b.auditor.gameOver.path("winnerPlayerIds"),
                "both seats agree on the winners");

        assertEquals(1, a.auditor.resumes, "alice resumed once mid-game");
        // bob resumed once by token, once by recovery join (fresh auditor counts 1)
        assertTrue(bob.auditor.resumes >= 1, "bob resumed by token before the recovery handover");
        assertTrue(b.auditor.resumes >= 1, "recovered bob went through the resume sequence");
        assertTrue(b.auditor.backfillLogs > 0, "recovery resume must backfill the log tail");

        // chat crossed both ways (the recovered Bob may have caught Alice's line
        // in the §14 backfill rather than live — both routes are correct)
        assertTrue(a.auditor.sawChatContaining(BOB_CHAT), "alice saw bob's chat");
        assertTrue(bob.auditor.sawChatContaining(ALICE_CHAT) || b.auditor.sawChatContaining(ALICE_CHAT),
                "bob saw alice's chat (live or via backfill)");
        // idempotency: the duplicated chat.send executed exactly once
        assertEquals(1, a.auditor.chatCountContaining(ALICE_CHAT),
                "alice's duplicated chat.send must appear exactly once in her own echo");
        long bobSawAlice = bob.auditor.chatCountContaining(ALICE_CHAT)
                + b.auditor.chatCountContaining(ALICE_CHAT);
        assertTrue(bobSawAlice <= 2, // live on old socket + backfill on new is legal; 2 executions is not
                "alice's chat must not have executed twice (bob saw it " + bobSawAlice + " times)");

        // coverage goals: depend on how the shuffled game plays out (Coverage)
        int combat = a.auditor.combatPrompts + bob.auditor.combatPrompts + b.auditor.combatPrompts;
        Coverage.goal("multi-human", "combat declaration ask on a human seat", combat >= 1,
                combat + " combat asks");
        long bobBytes = bob.auditor.gameBytes + b.auditor.gameBytes;
        Coverage.goal("multi-human", "alice within the §7 budget (<12 MB)",
                a.auditor.gameBytes < 12_000_000, String.format("%.1f MB", a.auditor.gameBytes / 1_000_000.0));
        Coverage.goal("multi-human", "bob within the §7 budget (<12 MB)",
                bobBytes < 12_000_000, String.format("%.1f MB", bobBytes / 1_000_000.0));

        // ---- post-game: resume replays final state + game.over ----
        String gameId = a.auditor.gameId;
        a.drop();
        Client a2 = a.reconnect(port);
        a2.auditor.expectResume();
        ObjectNode resume = json.createObjectNode()
                .put("gameId", gameId).put("lastSeq", a2.auditor.lastSeq);
        JsonNode welcome = a2.hello(Map.of("token", a2.token, "resume", resume));
        assertTrue(welcome.path("resumed").asBoolean(), "post-game resume still welcome{resumed}");
        a2.await("final keyframe on post-game resume", 15,
                n -> "game.state".equals(n.path("t").asText())
                        && "over".equals(n.path("state").path("status").asText()));
        a2.await("game.over replay on post-game resume", 15,
                n -> "game.over".equals(n.path("t").asText()));

        // ---- rematch: the started lobby no longer holds its members (§5) ----
        String rematchId = a2.send("lobby.create", Map.of("format", "commander-ffa"));
        a2.awaitAck("rematch lobby.create", rematchId);
        String rematchCode = a2.await("rematch lobby.state", 10,
                n -> "lobby.state".equals(n.path("t").asText()) && n.hasNonNull("code"))
                .get("code").asText();
        assertNotEquals(code, rematchCode, "rematch is a fresh lobby");

        // ---- teardown: after the grace the game is gone (§14) ----
        Thread.sleep(TimeUnit.SECONDS.toMillis(GRACE_SECS + 5));
        String lateChat = a2.send("chat.send", Map.of("gameId", gameId, "text", "anyone here?"));
        JsonNode gone = a2.awaitAllowingErrors("UNKNOWN_GAME after teardown", 15,
                n -> "error".equals(n.path("t").asText()) && lateChat.equals(n.path("re").asText()));
        assertEquals("UNKNOWN_GAME", gone.path("code").asText(), "chat after teardown: " + gone);

        a2.drop();
        Client a3 = a2.reconnect(port);
        String lateResume = a3.send("session.hello", Map.of("v", 1, "token", a3.token,
                "resume", json.createObjectNode().put("gameId", gameId).put("lastSeq", 0)));
        JsonNode failed = a3.awaitAllowingErrors("RESUME_FAILED after teardown", 15,
                n -> "error".equals(n.path("t").asText()) && lateResume.equals(n.path("re").asText()));
        assertEquals("RESUME_FAILED", failed.path("code").asText(), "resume after teardown: " + failed);

        System.out.printf("[live m4] over: %s | alice prompts=%d/%d patches=%d resumes=%d | "
                        + "bob prompts=%d+%d patches=%d+%d | backfill=%d chatLines a=%d b=%d%n",
                a.auditor.gameOver.path("reason").asText(),
                a.auditor.promptsAnswered, a.auditor.promptsSeen, a.auditor.patches, a.auditor.resumes,
                bob.auditor.promptsSeen, b.auditor.promptsSeen, bob.auditor.patches, b.auditor.patches,
                b.auditor.backfillLogs, a.auditor.chatLines.size(),
                bob.auditor.chatLines.size() + b.auditor.chatLines.size());
    }

    /** What a seat runner does beyond playing: when to refresh, chat, hand over. */
    private record SeatScript(int dropAtPrompt, String chatText, int chatAtPrompt,
                              boolean recoveryHandover) {
    }

    private interface SeatRun {
        void run() throws Exception;
    }

    private static Thread seatThread(String name, List<Throwable> failures, SeatRun body) {
        Thread t = new Thread(() -> {
            try {
                body.run();
            } catch (Throwable e) {
                synchronized (failures) {
                    failures.add(e);
                }
            }
        }, name);
        t.setDaemon(true);
        return t;
    }

    /**
     * Plays one seat to game.over, executing the script along the way. The
     * client may be swapped (refresh, recovery); the final one lands in
     * {@code current} for the main thread's post-game checks.
     */
    private void playSeat(Client c, int port, String lobbyCode,
                          AtomicReference<Client> current, SeatScript script) throws Exception {
        Map<String, Integer> repeats = new HashMap<>();
        boolean dropped = false;
        boolean chatted = false;
        boolean handedOver = false;
        JsonNode over = null;
        while (over == null) {
            JsonNode n = c.stash.poll();
            if (n == null) {
                n = c.await("next game event", 300, x -> true);
            }
            switch (n.path("t").asText()) {
                case "game.prompt" -> {
                    // scripted refresh: drop while holding this unanswered prompt,
                    // resume, and require the same prompt back under the same id
                    if (!dropped && c.auditor.promptsSeen >= script.dropAtPrompt()) {
                        dropped = true;
                        long pendingId = n.path("promptId").asLong();
                        c = tokenRefresh(c, port);
                        current.set(c);
                        n = awaitPromptReEmit(c, pendingId);
                    } else if (!handedOver && script.recoveryHandover()
                            && chatted // keep ordering stable: chat first, then handover
                            && c.auditor.promptsSeen >= script.chatAtPrompt() + 4) {
                        handedOver = true;
                        Client fresh = recoveryHandover(c, port, lobbyCode);
                        current.set(fresh);
                        n = awaitPromptReEmit(fresh, n.path("promptId").asLong());
                        c = fresh;
                    }
                    autoAnswer(c, n, repeats);
                    if (!chatted && c.auditor.promptsSeen >= script.chatAtPrompt()
                            && c.auditor.gameId != null) {
                        chatted = true;
                        chatWithDuplicate(c, script.chatText());
                    }
                }
                case "game.over" -> over = n;
                default -> {
                }
            }
        }
        current.set(c);
    }

    /** Hard-drop + token resume; returns the same client wired to a new socket. */
    private Client tokenRefresh(Client c, int port) throws Exception {
        c.drop();
        Client next = c.reconnect(port);
        next.auditor.expectResume();
        ObjectNode resume = json.createObjectNode()
                .put("gameId", next.auditor.gameId).put("lastSeq", next.auditor.lastSeq);
        JsonNode welcome = next.hello(Map.of("token", next.token, "resume", resume));
        assertTrue(welcome.path("resumed").asBoolean(),
                "[" + next.label + "] token resume must welcome{resumed:true}: " + welcome);
        return next;
    }

    /** After a refresh/recovery the pending prompt must come back under its original id (§14). */
    private JsonNode awaitPromptReEmit(Client c, long expectedId) throws Exception {
        JsonNode reEmitted = c.await("prompt re-emit after resume", 60,
                n -> "game.prompt".equals(n.path("t").asText()));
        assertEquals(expectedId, reEmitted.path("promptId").asLong(),
                "[" + c.label + "] resume must re-emit the pending prompt under its original id");
        return reEmitted;
    }

    /**
     * Lost token: a brand-new session (fresh hello → new token/userId) claims
     * the seat by displayName on the running game. The resume sequence follows
     * on the new socket; the old one is bumped with a fatal error.
     */
    private Client recoveryHandover(Client old, int port, String lobbyCode) throws Exception {
        Client fresh = Client.connect(port, old.label + "-recovered");
        fresh.hello(Map.of());
        assertNotEquals(old.token, fresh.token, "recovery client must be a genuinely new session");
        fresh.auditor.expectResume();
        fresh.awaitAck("recovery lobby.join",
                fresh.send("lobby.join", Map.of("code", lobbyCode, "displayName", "Bob")));
        // the resume sequence leads with a keyframe (§14) — wait for it so the
        // auditor is grounded before prompts flow
        fresh.await("recovery keyframe", 30, n -> "game.state".equals(n.path("t").asText()));
        JsonNode bump = old.awaitAllowingErrors("old socket bumped", 30,
                n -> "error".equals(n.path("t").asText()));
        assertEquals("AUTH_FAILED", bump.path("code").asText(),
                "old bob socket must be bumped off the seat: " + bump);
        return fresh;
    }

    /** chat.send, then the same frame again verbatim: two acks, one execution (§14). */
    private void chatWithDuplicate(Client c, String text) throws Exception {
        Map<String, Object> fields = Map.of("gameId", c.auditor.gameId, "text", text);
        String id = c.send("chat.send", fields);
        c.awaitAck("chat.send", id);
        c.sendWithId("chat.send", id, fields);
        c.awaitAck("duplicate chat.send (idempotent re-ack)", id);
    }
}
