package night.bridge.xmage;

import night.bridge.config.Config;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Factory + lifecycle for XMage seat sessions: the shared scheduler pings
 * every live session every 10 s (spike cadence, design §4), and /healthz
 * reads reachability + live-session count from here (design §12).
 */
public final class XmageGateway implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(XmageGateway.class);
    private static final long PROBE_CACHE_MILLIS = 5_000;

    private final Config config;
    private final ScheduledExecutorService scheduler =
            Executors.newSingleThreadScheduledExecutor(Thread.ofVirtual().name("xmage-scheduler").factory());
    private final Set<SeatSession> live = ConcurrentHashMap.newKeySet();

    private volatile long lastProbeAt;
    private volatile boolean lastProbeUp;

    public XmageGateway(Config config) {
        this.config = config;
        scheduler.scheduleAtFixedRate(this::pingAll, 10, 10, TimeUnit.SECONDS);
    }

    /**
     * Creates and connects a seat session; null if the connect fails. The
     * caller attaches the callback sink (the seat pump) before any table
     * activity starts — connecting alone produces no ClientCallbacks.
     */
    public SeatSession connectSeat(String username) {
        SeatSession seat = new SeatSession(username);
        if (!seat.connect(config.xmage().host(), config.xmage().port())) {
            return null;
        }
        live.add(seat);
        return seat;
    }

    public void release(SeatSession seat) {
        live.remove(seat);
        seat.close();
    }

    private void pingAll() {
        for (SeatSession seat : live) {
            if (seat.isConnected()) {
                seat.ping();
            } else {
                log.warn("seat session '{}' no longer connected", seat.username());
            }
        }
    }

    /** healthz payload: TCP reachability (cached 5 s) + live session count. */
    public Map<String, Object> health() {
        long now = System.currentTimeMillis();
        if (now - lastProbeAt > PROBE_CACHE_MILLIS) {
            lastProbeAt = now;
            lastProbeUp = probe();
        }
        return Map.of("connected", lastProbeUp, "sessions", live.size());
    }

    private boolean probe() {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(config.xmage().host(), config.xmage().port()), 1_000);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    @Override
    public void close() {
        scheduler.shutdownNow();
        for (SeatSession seat : live) {
            seat.close();
        }
        live.clear();
    }
}
