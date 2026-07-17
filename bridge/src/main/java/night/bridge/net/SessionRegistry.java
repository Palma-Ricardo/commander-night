package night.bridge.net;

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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Browser sessions: token → identity + live connection (design §10).
 *
 * <p>All mutable state is owned by a single-thread executor (design §4);
 * public methods only enqueue. Replies leave through the target {@link Conn}'s
 * own send queue, so nothing here ever touches a socket.
 *
 * <p>Hello semantics implemented (protocol §4/§16.6): no token or unknown
 * token → fresh session, mint token + userId, return the token in
 * {@code welcome.token}. Known token → re-bind, bump any previous connection
 * (single-tab rule). Any {@code resume} → {@code RESUME_FAILED} until games
 * exist (M2+); the client falls back to a fresh hello.
 */
public final class SessionRegistry implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(SessionRegistry.class);

    static final int PROTOCOL_VERSION = 1;

    /** One established browser session. Touched only on {@link #exec}. */
    private static final class Session {
        final String token;
        final String userId;
        Conn conn;

        Session(String token, String userId) {
            this.token = token;
            this.userId = userId;
        }
    }

    private final ExecutorService exec = Executors.newSingleThreadExecutor(
            Thread.ofVirtual().name("session-registry").factory());
    private final Map<String, Session> byToken = new HashMap<>();
    private final SecureRandom random = new SecureRandom();

    void hello(Conn conn, Hello hello) {
        exec.execute(() -> handleHello(conn, hello));
    }

    void disconnected(Conn conn) {
        exec.execute(() -> {
            for (Session s : byToken.values()) {
                if (s.conn == conn) {
                    s.conn = null;
                }
            }
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
            // Games arrive in M2; today every resume target is unknown. An unknown
            // token can never resume either (§16.6). No binding on a failed resume —
            // the client falls back to a fresh hello on the same socket.
            conn.send(Err.re(hello.id(), ErrorCode.RESUME_FAILED,
                    "cannot resume game " + hello.resume().gameId() + ": unknown game"));
            return;
        }
        Session session = hello.token() == null ? null : byToken.get(hello.token());
        boolean fresh = session == null;
        if (fresh) {
            session = new Session(mintToken(), UUID.randomUUID().toString());
            byToken.put(session.token, session);
            log.info("new session {} for connection {}", session.userId, conn.id());
        }
        Conn previous = session.conn;
        if (previous != null && previous != conn) {
            log.info("session {} re-bound: bumping connection {}", session.userId, previous.id());
            previous.sendAndClose(
                    Err.fatal(null, ErrorCode.AUTH_FAILED, "session was opened on a newer connection"),
                    WsCloseCodes.POLICY_VIOLATION, "superseded by a newer connection");
        }
        session.conn = conn;
        conn.send(new Welcome(hello.id(), PROTOCOL_VERSION, session.userId,
                fresh ? session.token : null, Role.PLAYER, false));
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
