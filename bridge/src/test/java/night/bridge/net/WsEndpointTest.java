package night.bridge.net;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.Javalin;
import night.bridge.config.Config;
import night.bridge.game.Games;
import night.bridge.lobby.LobbyService;
import night.bridge.xmage.XmageGateway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * M1 exit criterion, as a test: a raw WS client can hello → welcome, and bad
 * input of any shape gets {@code error BAD_MESSAGE} — never a crash or a
 * silent close.
 */
class WsEndpointTest {

    private static Javalin app;
    private static SessionRegistry registry;
    private static XmageGateway gateway;
    private static LobbyService lobby;
    private static int port;
    private static final ObjectMapper json = new ObjectMapper();

    @BeforeAll
    static void start() {
        registry = new SessionRegistry();
        gateway = new XmageGateway(Config.DEFAULTS);
        Games games = new Games();
        lobby = new LobbyService(registry, gateway, games, Config.DEFAULTS);
        app = new WsEndpoint(new Codec(), registry, lobby, games, gateway::health).buildApp();
        app.start("127.0.0.1", 0);
        port = app.port();
    }

    @AfterAll
    static void stop() {
        app.stop();
        lobby.close();
        gateway.close();
        registry.close();
    }

    /** Minimal blocking client over the JDK's WebSocket (the design §13 test client). */
    private static final class Client implements WebSocket.Listener {
        final BlockingQueue<String> frames = new LinkedBlockingQueue<>();
        final CompletableFuture<Integer> closed = new CompletableFuture<>();
        private final StringBuilder partial = new StringBuilder();
        WebSocket ws;

        static Client connect() {
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

        @Override
        public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
            closed.complete(statusCode);
            return null;
        }

        void send(String text) {
            ws.sendText(text, true).join();
        }

        JsonNode next() throws Exception {
            String frame = frames.poll(5, TimeUnit.SECONDS);
            if (frame == null) {
                fail("no frame within 5s");
            }
            return json.readTree(frame);
        }

        void expectSilence() throws Exception {
            String frame = frames.poll(300, TimeUnit.MILLISECONDS);
            assertNull(frame, () -> "expected no frame, got: " + frame);
        }

        int awaitClose() throws Exception {
            return closed.get(5, TimeUnit.SECONDS);
        }

        void close() {
            ws.sendClose(WebSocket.NORMAL_CLOSURE, "bye").join();
        }
    }

    private static JsonNode hello(Client c, String id) throws Exception {
        c.send("{\"t\":\"session.hello\",\"id\":\"" + id + "\",\"v\":1}");
        return c.next();
    }

    @Test
    void freshHelloGetsWelcomeWithMintedToken() throws Exception {
        Client c = Client.connect();
        JsonNode w = hello(c, "c1");
        assertEquals("session.welcome", w.get("t").asText());
        assertEquals("c1", w.get("re").asText());
        assertEquals(1, w.get("v").asInt());
        assertFalse(w.get("userId").asText().isBlank());
        assertFalse(w.get("token").asText().isBlank());
        assertEquals("player", w.get("role").asText());
        assertFalse(w.get("resumed").asBoolean());
        c.close();
    }

    @Test
    void knownTokenRebindsToSameUserWithoutNewToken() throws Exception {
        Client a = Client.connect();
        JsonNode first = hello(a, "c1");
        String token = first.get("token").asText();
        String userId = first.get("userId").asText();
        a.close();

        Client b = Client.connect();
        b.send("{\"t\":\"session.hello\",\"id\":\"c2\",\"v\":1,\"token\":\"" + token + "\"}");
        JsonNode again = b.next();
        assertEquals("session.welcome", again.get("t").asText());
        assertEquals(userId, again.get("userId").asText());
        assertFalse(again.has("token"), "token is minted for fresh sessions only");
        b.close();
    }

    @Test
    void unknownTokenWithoutResumeIsAFreshSession() throws Exception {
        // Design §10: bridge restarted / stale storage — not an error.
        Client c = Client.connect();
        c.send("{\"t\":\"session.hello\",\"id\":\"c1\",\"v\":1,\"token\":\"stale-from-before-restart\"}");
        JsonNode w = c.next();
        assertEquals("session.welcome", w.get("t").asText());
        assertTrue(w.has("token"), "fresh session mints a new token");
        assertNotEquals("stale-from-before-restart", w.get("token").asText());
        c.close();
    }

    @Test
    void secondConnectionWithSameTokenBumpsTheFirst() throws Exception {
        Client a = Client.connect();
        String token = hello(a, "c1").get("token").asText();

        Client b = Client.connect();
        b.send("{\"t\":\"session.hello\",\"id\":\"c2\",\"v\":1,\"token\":\"" + token + "\"}");
        assertEquals("session.welcome", b.next().get("t").asText());

        JsonNode bump = a.next();
        assertEquals("error", bump.get("t").asText());
        assertEquals("AUTH_FAILED", bump.get("code").asText());
        assertTrue(bump.get("fatal").asBoolean());
        assertEquals(1008, a.awaitClose());
        b.close();
    }

    @Test
    void unsupportedVersionIsFatalAndCloses() throws Exception {
        Client c = Client.connect();
        c.send("{\"t\":\"session.hello\",\"id\":\"c1\",\"v\":2}");
        JsonNode e = c.next();
        assertEquals("error", e.get("t").asText());
        assertEquals("UNSUPPORTED_VERSION", e.get("code").asText());
        assertEquals("c1", e.get("re").asText());
        assertTrue(e.get("fatal").asBoolean());
        assertEquals(1002, c.awaitClose());
    }

    @Test
    void resumeFailsCleanlyAndFreshHelloStillWorks() throws Exception {
        Client c = Client.connect();
        c.send("{\"t\":\"session.hello\",\"id\":\"c1\",\"v\":1,\"token\":\"whatever\","
                + "\"resume\":{\"gameId\":\"g1\",\"lastSeq\":42}}");
        JsonNode e = c.next();
        assertEquals("error", e.get("t").asText());
        assertEquals("RESUME_FAILED", e.get("code").asText());
        assertEquals("c1", e.get("re").asText());

        // §16.6: the client falls back to a fresh hello on the same socket.
        assertEquals("session.welcome", hello(c, "c2").get("t").asText());
        c.close();
    }

    @Test
    void malformedFramesGetBadMessageAndTheSocketSurvives() throws Exception {
        Client c = Client.connect();
        for (String garbage : new String[]{"{oops", "[]", "\"hi\"", "{\"id\":\"x9\"}"}) {
            c.send(garbage);
            JsonNode e = c.next();
            assertEquals("error", e.get("t").asText(), "for frame: " + garbage);
            assertEquals("BAD_MESSAGE", e.get("code").asText(), "for frame: " + garbage);
            assertNull(e.get("fatal"), "BAD_MESSAGE is never fatal");
        }
        // The last garbage frame had a readable id → the error references it.
        c.send("{\"id\":\"x9\"}");
        assertEquals("x9", c.next().get("re").asText());

        assertEquals("session.welcome", hello(c, "c1").get("t").asText());
        c.close();
    }

    @Test
    void unknownTypeIsIgnoredSilently() throws Exception {
        Client c = Client.connect();
        c.send("{\"t\":\"future.thing\",\"id\":\"c1\",\"payload\":true}");
        c.expectSilence();
        // Socket unharmed:
        assertEquals("session.welcome", hello(c, "c2").get("t").asText());
        c.close();
    }

    @Test
    void serverTypeFromClientIsBadMessage() throws Exception {
        Client c = Client.connect();
        c.send("{\"t\":\"ack\",\"re\":\"z\"}");
        assertEquals("BAD_MESSAGE", c.next().get("code").asText());
        c.close();
    }

    @Test
    void binaryFramesAreBadMessage() throws Exception {
        Client c = Client.connect();
        c.ws.sendBinary(ByteBuffer.wrap(new byte[]{1, 2, 3}), true).join();
        JsonNode e = c.next();
        assertEquals("BAD_MESSAGE", e.get("code").asText());
        c.close();
    }

    @Test
    void healthzReportsUpAndXmageState() throws Exception {
        HttpResponse<String> res = HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/healthz")).build(),
                HttpResponse.BodyHandlers.ofString());
        assertEquals(200, res.statusCode());
        JsonNode body = json.readTree(res.body());
        assertTrue(body.get("up").asBoolean());
        assertNotNull(body.get("xmage").get("connected"));
    }
}
