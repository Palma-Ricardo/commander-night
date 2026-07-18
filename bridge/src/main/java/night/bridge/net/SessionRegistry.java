package night.bridge.net;

import night.bridge.game.GameCoordinator;
import night.bridge.game.Games;
import night.bridge.game.SeatPump;
import night.bridge.proto.Err;
import night.bridge.proto.ErrorCode;
import night.bridge.proto.Hello;
import night.bridge.proto.Role;
import night.bridge.proto.Welcome;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Browser sessions: token → identity + live connection (design §10).
 *
 * <p>All mutable state is owned by a single-thread executor (design §4);
 * public methods only enqueue. Replies leave through the target {@link Conn}'s
 * own send queue, so nothing here ever touches a socket.
 *
 * <p>Hello semantics (protocol §4/§14/§16.6): no token or unknown token →
 * fresh session, mint token + userId, return the token in {@code welcome.token}.
 * Known token → re-bind, bump any previous connection (single-tab rule).
 * {@code resume} with a known token and a live seat → {@code welcome
 * resumed:true} followed by the seat pump's replay (keyframe, pending prompt,
 * log tail); anything else → {@code RESUME_FAILED} and the client falls back
 * to a fresh hello + recovery join.
 */
public final class SessionRegistry implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(SessionRegistry.class);

    static final int PROTOCOL_VERSION = 1;

    /** One established browser session. Touched only on {@link #exec}. */
    private static final class Session {
        final String token;
        /** Mutable: recovery join re-points a session at a seat's identity (§10). */
        String userId;
        Conn conn;

        Session(String token, String userId) {
            this.token = token;
            this.userId = userId;
        }
    }

    private final ExecutorService exec = Executors.newSingleThreadExecutor(
            Thread.ofVirtual().name("session-registry").factory());
    private final Map<String, Session> byToken = new HashMap<>();
    /** userId → live connection; read from pumps/lobby via {@link #sinkFor}. */
    private final ConcurrentHashMap<String, Conn> liveByUser = new ConcurrentHashMap<>();
    /** userId → hello asked for stateMode:'keyframes' (§7 debug escape hatch); read by pumps. */
    private final ConcurrentHashMap<String, Boolean> keyframesOnlyByUser = new ConcurrentHashMap<>();
    /** userId → command idempotency cache (protocol §14); read on Jetty threads. */
    private final ConcurrentHashMap<String, IdemCache> idemByUser = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();
    private final Games games;

    public SessionRegistry(Games games) {
        this.games = games;
    }

    void hello(Conn conn, Hello hello) {
        exec.execute(() -> handleHello(conn, hello));
    }

    void disconnected(Conn conn) {
        exec.execute(() -> {
            for (Session s : byToken.values()) {
                if (s.conn == conn) {
                    s.conn = null;
                    liveByUser.remove(s.userId, conn);
                }
            }
        });
    }

    /**
     * A stable per-user outbound: resolves the live connection at send time, so
     * pumps survive connection churn without knowing about it (design §4).
     * Sends while the user is disconnected are dropped; resume backfills.
     */
    public ClientSink sinkFor(String userId) {
        return msg -> {
            Conn conn = liveByUser.get(userId);
            if (conn != null) {
                conn.send(msg);
            }
        };
    }

    /** The user's command idempotency cache (protocol §14); created on first use. */
    IdemCache idemFor(String userId) {
        return idemByUser.computeIfAbsent(userId, u -> new IdemCache());
    }

    /**
     * Lost-token recovery (design §10): the caller's session abandons its
     * fresh identity and takes over {@code seatUserId} — the seat's sink then
     * resolves to the caller's connection. Any connection still holding the
     * seat is bumped (single-tab rule). {@code then} runs after the swap, so
     * a chained pump replay cannot race it.
     */
    public void adopt(String callerUserId, String seatUserId, Runnable then) {
        exec.execute(() -> {
            Session caller = null;
            for (Session s : byToken.values()) {
                if (s.userId.equals(callerUserId) && s.conn != null) {
                    caller = s;
                }
            }
            if (caller == null) {
                log.info("recovery adopt: session {} vanished before re-bind", callerUserId);
                return;
            }
            Conn seated = liveByUser.get(seatUserId);
            if (seated != null && seated != caller.conn) {
                log.info("recovery: bumping connection {} off seat {}", seated.id(), seatUserId);
                seated.sendAndClose(
                        Err.fatal(null, ErrorCode.AUTH_FAILED, "your seat was re-bound to a new session"),
                        WsCloseCodes.POLICY_VIOLATION, "seat re-bound to a new session");
            }
            // The seat's previous token is declared lost: retire its session(s)
            // entirely, or a later hello with the "lost" token would silently
            // hijack the seat back and collide in the idempotency cache.
            Session adopted = caller;
            byToken.values().removeIf(s -> s != adopted && s.userId.equals(seatUserId));
            liveByUser.remove(callerUserId, caller.conn);
            caller.userId = seatUserId;
            caller.conn.userId(seatUserId);
            liveByUser.put(seatUserId, caller.conn);
            Boolean keyframes = keyframesOnlyByUser.remove(callerUserId);
            keyframesOnlyByUser.put(seatUserId, keyframes != null && keyframes);
            IdemCache cache = idemByUser.remove(callerUserId);
            if (cache != null) {
                idemByUser.put(seatUserId, cache);
            }
            log.info("recovery: session {} adopted seat {}", callerUserId, seatUserId);
            then.run();
        });
    }

    private void handleHello(Conn conn, Hello hello) {
        if (hello.v() != PROTOCOL_VERSION) {
            conn.sendAndClose(
                    Err.fatal(hello.id(), ErrorCode.UNSUPPORTED_VERSION,
                            "protocol v" + hello.v() + " is not supported; this bridge speaks v" + PROTOCOL_VERSION),
                    WsCloseCodes.PROTOCOL_ERROR, "unsupported protocol version");
            return;
        }
        if (hello.resume() != null) {
            handleResume(conn, hello);
            return;
        }
        Session session = hello.token() == null ? null : byToken.get(hello.token());
        boolean fresh = session == null;
        if (fresh) {
            session = new Session(mintToken(), UUID.randomUUID().toString());
            byToken.put(session.token, session);
            log.info("new session {} for connection {}", session.userId, conn.id());
        }
        bind(conn, session, hello);
        conn.send(new Welcome(hello.id(), PROTOCOL_VERSION, session.userId,
                fresh ? session.token : null, Role.PLAYER, false));
    }

    /**
     * hello{resume} (protocol §14): only a known token holding a live seat in
     * a known game resumes — the welcome precedes the pump's replay because
     * both leave through the same connection queue, and the replay is only
     * enqueued after the welcome (happens-before via this executor).
     */
    private void handleResume(Conn conn, Hello hello) {
        Session session = hello.token() == null ? null : byToken.get(hello.token());
        if (session == null) {
            // Unknown token can never resume (§16.6) — fresh hello + recovery join instead.
            conn.send(Err.re(hello.id(), ErrorCode.RESUME_FAILED,
                    "unknown session token — hello fresh and re-join by lobby code"));
            return;
        }
        String gameId = hello.resume().gameId();
        GameCoordinator game = games.byId(gameId);
        SeatPump pump = game == null ? null : game.pumpFor(session.userId);
        if (pump == null) {
            conn.send(Err.re(hello.id(), ErrorCode.RESUME_FAILED,
                    "cannot resume game " + gameId + ": unknown game or no seat in it"));
            return;
        }
        bind(conn, session, hello);
        conn.send(new Welcome(hello.id(), PROTOCOL_VERSION, session.userId, null, Role.PLAYER, true));
        if (!pump.resume(hello.resume().lastSeq())) {
            // torn down between lookup and enqueue — client falls back like any failed resume
            conn.send(Err.re(hello.id(), ErrorCode.RESUME_FAILED,
                    "cannot resume game " + gameId + ": the game is gone"));
        }
    }

    private void bind(Conn conn, Session session, Hello hello) {
        Conn previous = session.conn;
        if (previous != null && previous != conn) {
            log.info("session {} re-bound: bumping connection {}", session.userId, previous.id());
            previous.sendAndClose(
                    Err.fatal(null, ErrorCode.AUTH_FAILED, "session was opened on a newer connection"),
                    WsCloseCodes.POLICY_VIOLATION, "superseded by a newer connection");
        }
        session.conn = conn;
        conn.userId(session.userId);
        liveByUser.put(session.userId, conn);
        keyframesOnlyByUser.put(session.userId, "keyframes".equals(hello.stateMode()));
    }

    /** Whether this user's last hello chose keyframes-only state sync (protocol §7). */
    public boolean keyframesOnly(String userId) {
        return Boolean.TRUE.equals(keyframesOnlyByUser.get(userId));
    }

    /** 128-bit random session token, base64url — never shown to a human (design §10). */
    private String mintToken() {
        byte[] bytes = new byte[16];
        random.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    @Override
    public void close() {
        exec.close();
    }
}
