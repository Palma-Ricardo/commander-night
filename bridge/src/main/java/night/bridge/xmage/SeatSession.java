package night.bridge.xmage;

import mage.interfaces.MageClient;
import mage.interfaces.callback.ClientCallback;
import mage.remote.Connection;
import mage.remote.Session;
import mage.remote.SessionImpl;
import mage.utils.MageVersion;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.function.Consumer;

/**
 * One XMage client session = one human seat (design §2/§5). Implements
 * MageClient; every callback is decompressed here and handed to the sink
 * (the seat pump enqueue) — callbacks arrive on up to 10 XMage threads, so
 * nothing beyond decompress-and-enqueue happens on them.
 */
public final class SeatSession implements MageClient {

    private static final Logger log = LoggerFactory.getLogger(SeatSession.class);

    /** Compiling against the dist's jars makes this the server's exact version (design §1). */
    private final MageVersion version = new MageVersion(MageClient.class);
    private final String username;
    private final Session session;
    private volatile Consumer<ClientCallback> sink = cb -> log.warn("callback {} before sink attached", cb.getMethod());
    /** Transport-loss notification — the seat pump's recovery entry (design §5). */
    private volatile Runnable disconnectListener = () -> {
    };
    private volatile String host;
    private volatile int port;
    /** XMage's server-side restore handshake key: our previous session id. */
    private volatile String lastSessionId = "";
    private volatile CallbackTap tap;
    private volatile boolean closing;
    /** connectStart/connectStop re-fire disconnected() internally; ignore our own noise. */
    private volatile boolean reconnecting;

    public SeatSession(String username) {
        this.username = username;
        this.session = new SessionImpl(this);
    }

    /** Where callbacks go — the seat pump's enqueue. Must be set before connect(). */
    public void sink(Consumer<ClientCallback> sink) {
        this.sink = sink;
    }

    /**
     * Optional capture (design §12): callbacks are tapped BEFORE decompression
     * so the .ser file holds the exact wire objects — the golden-fixture
     * source (design §13). Owned here; closed with the session.
     */
    public void tap(CallbackTap tap) {
        this.tap = tap;
    }

    /** Transport-loss listener — the seat pump's recovery kick (design §5). */
    public void onDisconnected(Runnable listener) {
        this.disconnectListener = listener;
    }

    public boolean connect(String host, int port) {
        this.host = host;
        this.port = port;
        boolean ok = session.connectStart(newConnection());
        if (ok) {
            lastSessionId = session.getSessionId();
            log.info("xmage session '{}' connected to {}:{}", username, host, port);
        } else {
            log.error("xmage session '{}' failed to connect to {}:{}: {}", username, host, port,
                    session.getLastError());
        }
        return ok;
    }

    /**
     * Re-login after transport loss, restoring the server-side user via the
     * restore-session handshake (source-verified: server {@code Session.validateUser}
     * matches {@code restoreSessionId}, flags a reconnection, and re-attaches the
     * user's active tables in {@code User.onReconnect}). Blocking — never call
     * on the seat pump.
     */
    public boolean reconnect() {
        if (closing) {
            return false;
        }
        reconnecting = true;
        try {
            if (!lastSessionId.isEmpty()) {
                session.setRestoreSessionId(lastSessionId);
            }
            boolean ok = session.connectStart(newConnection());
            if (ok && closing) {
                // released while the connect was in flight — don't leak a live session
                log.info("xmage session '{}' reconnected after release — closing again", username);
                session.connectStop(false, false);
                return false;
            }
            if (ok) {
                lastSessionId = session.getSessionId();
                log.info("xmage session '{}' reconnected to {}:{}", username, host, port);
            } else {
                log.warn("xmage session '{}' reconnect failed: {}", username, session.getLastError());
            }
            return ok;
        } catch (Exception e) {
            log.warn("xmage session '{}' reconnect threw: {}", username, e.toString());
            return false;
        } finally {
            reconnecting = false;
        }
    }

    private Connection newConnection() {
        Connection connection = new Connection();
        connection.setUsername(username);
        connection.setHost(host);
        connection.setPort(port);
        connection.setProxyType(Connection.ProxyType.NONE);
        return connection;
    }

    public Session session() {
        return session;
    }

    public String username() {
        return username;
    }

    public boolean isConnected() {
        return session.isConnected();
    }

    public void ping() {
        try {
            if (session.isConnected()) {
                session.ping();
            }
        } catch (Exception e) {
            log.warn("ping failed for '{}': {}", username, e.toString());
        }
    }

    public void close() {
        closing = true;
        try {
            session.connectStop(false, false);
        } catch (Exception e) {
            log.debug("connectStop for '{}': {}", username, e.toString());
        }
        CallbackTap t = tap;
        if (t != null) {
            t.close();
        }
    }

    // ---- MageClient ----

    @Override
    public MageVersion getVersion() {
        return version;
    }

    @Override
    public void connected(String message) {
        log.info("'{}' server says connected: {}", username, message);
    }

    @Override
    public void disconnected(boolean askToReconnect, boolean keepMySessionActive) {
        if (closing || reconnecting) {
            return; // our own connectStop / connectStart teardown noise
        }
        log.warn("'{}' disconnected from xmage (askToReconnect={}, keepSession={}) — kicking seat recovery",
                username, askToReconnect, keepMySessionActive);
        disconnectListener.run();
    }

    @Override
    public void showMessage(String message) {
        log.info("'{}' server message: {}", username, message);
    }

    @Override
    public void showError(String message) {
        log.warn("'{}' server error: {}", username, message);
    }

    @Override
    public void onNewConnection() {
        // single connection per seat; nothing to reset
    }

    @Override
    public void onCallback(ClientCallback callback) {
        try {
            CallbackTap t = tap;
            if (t != null) {
                t.tap(callback);    // pre-decompress: exact wire objects (design §13)
            }
            callback.decompressData();
            sink.accept(callback);
        } catch (Throwable t) {
            // Never let an exception escape into JBoss Remoting's callback threads.
            log.error("callback {} for '{}' failed pre-enqueue", callback.getMethod(), username, t);
        }
    }
}
