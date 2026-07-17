package night.bridge.net;

import io.javalin.Javalin;
import io.javalin.websocket.WsConfig;
import night.bridge.proto.Err;
import night.bridge.proto.ErrorCode;
import night.bridge.proto.Hello;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * The bridge's HTTP/WS face: {@code /ws} (protocol v1) and {@code /healthz}
 * (design §12). Jetty threads never touch bridge state — they decode and
 * route; replies go out through each connection's own send queue (design §4).
 */
public final class WsEndpoint {

    private static final Logger log = LoggerFactory.getLogger(WsEndpoint.class);

    private final Codec codec;
    private final SessionRegistry registry;
    private final Map<String, Conn> conns = new ConcurrentHashMap<>();

    public WsEndpoint(Codec codec, SessionRegistry registry) {
        this.codec = codec;
        this.registry = registry;
    }

    /** Builds the Javalin app (not yet started — callers pick host/port). */
    public Javalin buildApp() {
        Javalin app = Javalin.create(cfg -> {
            cfg.showJavalinBanner = false;
            cfg.jetty.modifyWebSocketServletFactory(ws -> {
                // Keepalive is server pings (below); the timeout only reaps dead peers.
                ws.setIdleTimeout(Duration.ofMinutes(5));
                // Command frames are small; the ceiling exists for deck uploads (M2).
                ws.setMaxTextMessageSize(256 * 1024);
            });
        });
        app.get("/healthz", ctx -> ctx.json(Map.of(
                "up", true,
                // Hardwired until the XMage connector lands (M2).
                "xmage", Map.of("connected", false))));
        app.ws("/ws", this::configureWs);
        return app;
    }

    private void configureWs(WsConfig ws) {
        ws.onConnect(ctx -> {
            ctx.enableAutomaticPings(15, TimeUnit.SECONDS);
            conns.put(ctx.sessionId(), new Conn(ctx, codec));
        });
        ws.onMessage(ctx -> {
            Conn conn = conns.get(ctx.sessionId());
            if (conn != null) {
                route(conn, ctx.message());
            }
        });
        ws.onBinaryMessage(ctx -> {
            Conn conn = conns.get(ctx.sessionId());
            if (conn != null) {
                conn.send(Err.of(ErrorCode.BAD_MESSAGE, "binary frames are not part of protocol v1"));
            }
        });
        ws.onClose(ctx -> {
            Conn conn = conns.remove(ctx.sessionId());
            if (conn != null) {
                conn.shutdown();
                registry.disconnected(conn);
            }
        });
        ws.onError(ctx -> log.warn("ws error on {}: {}", ctx.sessionId(),
                ctx.error() == null ? "unknown" : ctx.error().toString()));
    }

    private void route(Conn conn, String frame) {
        switch (codec.decode(frame)) {
            case Codec.Decoded.Bad(String reason, String re) ->
                    conn.send(new Err(re, ErrorCode.BAD_MESSAGE, reason, null));
            case Codec.Decoded.Ignored(String t) ->
                    // §3 forward compatibility — includes v1 commands from later milestones.
                    log.info("ignoring message type '{}' from {}", t, conn.id());
            case Codec.Decoded.Ok(Hello hello) -> registry.hello(conn, hello);
            // Exhaustive: Hello is the only ClientMsg in M1. New commands added to
            // the vocabulary make this switch fail to compile until routed (lobby
            // executor / seat pumps, design §4).
        }
    }
}
