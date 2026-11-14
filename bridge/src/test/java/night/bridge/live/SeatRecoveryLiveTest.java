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
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

import static night.bridge.live.LiveHarness.autoAnswer;
import static night.bridge.live.LiveHarness.json;
import static night.bridge.live.LiveHarness.xmageUp;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The design-§5 seat-recovery live verification (implemented M4, verified
 * here): mid-game, with a prompt deliberately left pending, the XMage server
 * is frozen with SIGSTOP until the bridge's session layer notices the
 * transport loss. Asserted sequence:
 *
 * <ol>
 *   <li>{@code game.log kind:status} "reconnecting to the game server…";</li>
 *   <li>a positional answer during the outage → {@code error UPSTREAM_ERROR}
 *       non-fatal, prompt still pending;</li>
 *   <li>after SIGCONT, the restore-session handshake re-attaches the seat:
 *       status "reconnected to the game server", then a fresh keyframe and
 *       the pending prompt re-emitted under its original promptId on the
 *       same socket (no seq jump, no backfill);</li>
 *   <li>the game continues to a clean game.over with all protocol
 *       invariants green.</li>
 * </ol>
 *
 * Requires a local XMage server on 17171 that this test may freeze — do not
 * share the server with a concurrent live run: SIGSTOP stalls every game on
 * it. {@code mvn -Plive test -Dtest=SeatRecoveryLiveTest}
 */
@Tag("live")
class SeatRecoveryLiveTest {

    @Test
    @Timeout(value = 30, unit = TimeUnit.MINUTES)
    void seatRecoversAfterServerFreeze() throws Exception {
        assumeTrue(xmageUp(), "local XMage server on 17171 required (vendor/xmage-dist)");
        long serverPid = mageServerPid().orElseThrow(() ->
                new org.opentest4j.TestAbortedException("cannot find the mage-server process to freeze"));

        Config config = new Config("127.0.0.1:0", new Config.Xmage("127.0.0.1", 17171),
                100, new Config.LogBackfill(200, 50), true,
                "../vendor/xmage-dist/xmage/mage-client/sample-decks/Commander", 900);
        Games games = new Games();
        SessionRegistry registry = new SessionRegistry(games);
        XmageGateway gateway = new XmageGateway(config);
        LobbyService lobby = new LobbyService(registry, gateway, games, config);
        Javalin app = new WsEndpoint(new Codec(), registry, lobby, games, gateway::health).buildApp();
        app.start("127.0.0.1", 0);
        try {
            runGame(Client.connect(app.port(), "recovery"), serverPid);
        } finally {
            signal(serverPid, "CONT");      // never leave the dev server frozen
            app.stop();
            lobby.close();
            gateway.close();
            registry.close();
        }
    }

    private void runGame(Client c, long serverPid) throws Exception {
        c.hello(Map.of());
        c.awaitAck("lobby.create", c.send("lobby.create", Map.of("format", "commander-ffa")));
        String code = c.await("lobby.state with code", 10,
                n -> "lobby.state".equals(n.path("t").asText()) && n.hasNonNull("code"))
                .get("code").asText();
        c.awaitAck("lobby.join", c.send("lobby.join", Map.of("code", code, "displayName", "Ricardo")));
        c.awaitAck("lobby.deck", c.send("lobby.deck",
                Map.of("format", "dck", "content", Files.readString(LiveHarness.SAMPLE_DECK))));
        c.awaitAck("lobby.ready", c.send("lobby.ready", Map.of("ready", true)));
        c.awaitAck("lobby.start", c.send("lobby.start", Map.of("fillAI", true)));

        Map<String, Integer> repeats = new HashMap<>();
        boolean outageDone = false;
        JsonNode over = null;
        while (over == null) {
            JsonNode n = c.stash.poll();
            if (n == null) {
                n = c.await("next game event", 300, x -> true);
            }
            switch (n.path("t").asText()) {
                case "game.prompt" -> {
                    if (!outageDone && c.auditor.promptsAnswered >= 8 && c.auditor.gameId != null) {
                        outageDone = true;
                        outageAndRecovery(c, serverPid, n);
                        // the re-emitted / re-fired prompt comes through the normal
                        // loop; the held prompt itself is answered there too
                    } else {
                        autoAnswer(c, n, repeats);
                    }
                }
                case "game.over" -> over = n;
                default -> {
                }
            }
        }

        Auditor a = c.auditor;
        assertEquals(List.of(), a.violations, "protocol invariant violations");
        assertTrue(a.sawOver, "final keyframe must carry status:over before game.over");
        assertTrue(a.promptsAnswered > 10, "the game must keep flowing after recovery, got "
                + a.promptsAnswered + " answered prompts");
        System.out.printf("[recovery] game over: %s | prompts=%d/%d patches=%d keyframes=%d%n",
                a.gameOver.path("reason").asText(), a.promptsAnswered, a.promptsSeen,
                a.patches, a.keyframes);
    }

    /**
     * The outage, entered with {@code held} pending and unanswered. Frames
     * are pulled with {@code awaitAllowingErrors}: the §5 contract makes
     * UPSTREAM_ERROR frames expected data here.
     */
    private void outageAndRecovery(Client c, long serverPid, JsonNode held) throws Exception {
        long heldPromptId = held.path("promptId").asLong();
        String gameId = held.path("gameId").asText();
        System.out.printf("[recovery] freezing mage-server (pid %d) with prompt #%d pending%n",
                serverPid, heldPromptId);
        signal(serverPid, "STOP");
        try {
            // 1. transport-loss detection → the §5 status line. Detection rides
            // the JBoss lease / the 10 s session pings; give it a generous window.
            c.awaitAllowingErrors("status 'reconnecting…'", 240,
                    n -> "game.log".equals(n.path("t").asText())
                            && "status".equals(n.path("kind").asText())
                            && n.path("text").asText().startsWith("reconnecting"));
            System.out.println("[recovery] outage detected by the bridge");

            // 2. answers during the outage are rejected non-fatally, prompt kept
            String probeId = c.send("game.answer", Map.of("gameId", gameId,
                    "promptId", heldPromptId,
                    "answer", json.createObjectNode().put("type", "confirm").put("value", false)));
            JsonNode err = c.awaitAllowingErrors("UPSTREAM_ERROR for the outage probe", 60,
                    n -> "error".equals(n.path("t").asText()) && probeId.equals(n.path("re").asText()));
            assertEquals("UPSTREAM_ERROR", err.path("code").asText(), err.toString());
            assertFalse(err.path("fatal").asBoolean(false), "outage answers must reject non-fatally");
        } finally {
            c.auditor.expectRecoveryReground();
            signal(serverPid, "CONT");
            System.out.println("[recovery] mage-server thawed");
        }

        // 3. restore-session handshake → status line, then keyframe + prompt re-emit
        c.awaitAllowingErrors("status 'reconnected'", 180,
                n -> "game.log".equals(n.path("t").asText())
                        && "status".equals(n.path("kind").asText())
                        && n.path("text").asText().startsWith("reconnected"));
        JsonNode reground = c.awaitAllowingErrors("post-recovery keyframe", 60,
                n -> "game.state".equals(n.path("t").asText()));
        assertNotNull(reground.path("state").get("players"), "re-ground keyframe carries full state");
        JsonNode reprompt = c.awaitAllowingErrors("pending prompt re-emitted", 60,
                n -> "game.prompt".equals(n.path("t").asText()));
        assertEquals(heldPromptId, reprompt.path("promptId").asLong(),
                "the §5 re-ground must re-emit the pending prompt under its original promptId");
        c.stash.add(reprompt);      // hand it to the main loop to answer
        System.out.println("[recovery] seat re-grounded: keyframe + prompt #" + heldPromptId);
    }

    private static Optional<Long> mageServerPid() {
        // the executable must be java: shell wrappers that merely mention the
        // jar on their command line would otherwise match (and freezing a
        // wrapper freezes nothing)
        return ProcessHandle.allProcesses()
                .filter(p -> p.info().command().orElse("").endsWith("java"))
                .filter(p -> p.info().commandLine().orElse("").contains("lib/mage-server-"))
                .map(ProcessHandle::pid)
                .findFirst();
    }

    private static void signal(long pid, String sig) throws Exception {
        Process p = new ProcessBuilder("kill", "-" + sig, Long.toString(pid))
                .inheritIO().start();
        assertEquals(0, p.waitFor(), "kill -" + sig + " " + pid + " failed");
    }
}
