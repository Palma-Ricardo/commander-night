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

    public SeatSession(String username) {
        this.username = username;
        this.session = new SessionImpl(this);
    }

    /** Where callbacks go — the seat pump's enqueue. Must be set before connect(). */
    public void sink(Consumer<ClientCallback> sink) {
        this.sink = sink;
    }

    public boolean connect(String host, int port) {
        Connection connection = new Connection();
        connection.setUsername(username);
        connection.setHost(host);
        connection.setPort(port);
        connection.setProxyType(Connection.ProxyType.NONE);
        boolean ok = session.connectStart(connection);
        if (ok) {
            log.info("xmage session '{}' connected to {}:{}", username, host, port);
        } else {
            log.error("xmage session '{}' failed to connect to {}:{}: {}", username, host, port,
                    session.getLastError());
        }
        return ok;
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
        try {
            session.connectStop(false, false);
        } catch (Exception e) {
            log.debug("connectStop for '{}': {}", username, e.toString());
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
        // Seat recovery (design §5) is M4; today we log and the pump notices
        // failed sends when it next answers.
        log.warn("'{}' disconnected from xmage (askToReconnect={}, keepSession={})",
                username, askToReconnect, keepMySessionActive);
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
            callback.decompressData();
            sink.accept(callback);
        } catch (Throwable t) {
            // Never let an exception escape into JBoss Remoting's callback threads.
            log.error("callback {} for '{}' failed pre-enqueue", callback.getMethod(), username, t);
        }
    }
}
