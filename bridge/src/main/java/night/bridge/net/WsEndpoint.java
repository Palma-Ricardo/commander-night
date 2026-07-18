package night.bridge.net;

import io.javalin.Javalin;
import io.javalin.websocket.WsConfig;
import night.bridge.game.GameCoordinator;
import night.bridge.game.Games;
import night.bridge.game.SeatPump;
import night.bridge.lobby.LobbyService;
import night.bridge.proto.ClientMsg;
import night.bridge.proto.Err;
import night.bridge.proto.ErrorCode;
import night.bridge.proto.GameAction;
import night.bridge.proto.GameAnswer;
import night.bridge.proto.GameResync;
import night.bridge.proto.Hello;
import night.bridge.proto.LobbyCreate;
import night.bridge.proto.LobbyDeck;
import night.bridge.proto.LobbyJoin;
import night.bridge.proto.LobbyReady;
import night.bridge.proto.LobbyStart;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * The bridge's HTTP/WS face: {@code /ws} (protocol v1) and {@code /healthz}
 * (design §12). Jetty threads never touch bridge state — they decode and
 * route: {@code lobby.*} to the lobby executor, {@code game.*} to the target
 * seat pump (design §4); replies go out through each connection's own send
 * queue.
 */
public final class WsEndpoint {

    private static final Logger log = LoggerFactory.getLogger(WsEndpoint.class);

    private final Codec codec;
    private final SessionRegistry registry;
    private final LobbyService lobby;
    private final Games games;
    private final Supplier<Map<String, Object>> xmageHealth;
    private final Map<String, Conn> conns = new ConcurrentHashMap<>();

    public WsEndpoint(Codec codec, SessionRegistry registry, LobbyService lobby,
                      Games games, Supplier<Map<String, Object>> xmageHealth) {
        this.codec = codec;
        this.registry = registry;
        this.lobby = lobby;
        this.games = games;
        this.xmageHealth = xmageHealth;
    }

    /** Builds the Javalin app (not yet started — callers pick host/port). */
    public Javalin buildApp() {
        Javalin app = Javalin.create(cfg -> {
            cfg.showJavalinBanner = false;
            cfg.jetty.modifyWebSocketServletFactory(ws -> {
                // Keepalive is server pings (below); the timeout only reaps dead peers.
                ws.setIdleTimeout(Duration.ofMinutes(5));
                // Command frames are small; the ceiling exists for deck uploads.
                ws.setMaxTextMessageSize(256 * 1024);
            });
        });
        app.get("/healthz", ctx -> ctx.json(Map.of(
                "up", true,
                "xmage", xmageHealth.get())));
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
            case Codec.Decoded.Ok(LobbyCreate cmd) -> lobbyRoute(conn, cmd);
            case Codec.Decoded.Ok(LobbyJoin cmd) -> lobbyRoute(conn, cmd);
            case Codec.Decoded.Ok(LobbyDeck cmd) -> lobbyRoute(conn, cmd);
            case Codec.Decoded.Ok(LobbyReady cmd) -> lobbyRoute(conn, cmd);
            case Codec.Decoded.Ok(LobbyStart cmd) -> lobbyRoute(conn, cmd);
            case Codec.Decoded.Ok(GameAnswer cmd) -> {
                SeatPump pump = pumpFor(conn, cmd.id(), cmd.gameId());
                if (pump != null) {
                    pump.answer(cmd, conn::send);
                }
            }
            case Codec.Decoded.Ok(GameAction cmd) -> {
                SeatPump pump = pumpFor(conn, cmd.id(), cmd.gameId());
                if (pump != null) {
                    pump.action(cmd, conn::send);
                }
            }
            case Codec.Decoded.Ok(GameResync cmd) -> {
                SeatPump pump = pumpFor(conn, cmd.id(), cmd.gameId());
                if (pump != null) {
                    pump.resync(cmd, conn::send);
                }
            }
            // Exhaustive over ClientMsg: a new command type fails to compile
            // here until it is routed to its owning executor (design §4).
        }
    }

    private void lobbyRoute(Conn conn, ClientMsg cmd) {
        String userId = conn.userId();
        if (userId == null) {
            conn.send(Err.re(cmd.id(), ErrorCode.AUTH_FAILED, "send session.hello first"));
            return;
        }
        lobby.handle(userId, cmd, conn::send);
    }

    /** Resolves the caller's seat pump for a game.* command; error-replies and returns null otherwise. */
    private SeatPump pumpFor(Conn conn, String cmdId, String gameId) {
        String userId = conn.userId();
        if (userId == null) {
            conn.send(Err.re(cmdId, ErrorCode.AUTH_FAILED, "send session.hello first"));
            return null;
        }
        GameCoordinator game = games.byId(gameId);
        if (game == null) {
            conn.send(Err.re(cmdId, ErrorCode.UNKNOWN_GAME, "unknown game " + gameId));
            return null;
        }
        SeatPump pump = game.pumpFor(userId);
        if (pump == null) {
            conn.send(Err.re(cmdId, ErrorCode.UNKNOWN_GAME, "no seat in game " + gameId));
            return null;
        }
        return pump;
    }
}
