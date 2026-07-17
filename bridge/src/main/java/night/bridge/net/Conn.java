package night.bridge.net;

import io.javalin.websocket.WsContext;
import night.bridge.proto.ServerMsg;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * One live WebSocket connection. All outbound traffic goes through a bounded
 * queue drained by a single virtual thread — the queue-and-drainer pair is
 * the connection's owning executor (design §4); callers on any thread only
 * enqueue. Overflow means a client that stopped reading: we close the socket
 * and let the resume flow (protocol §14) pick the session back up cheaply.
 */
final class Conn {

    private static final Logger log = LoggerFactory.getLogger(Conn.class);

    static final int SEND_QUEUE_CAPACITY = 256;

    private sealed interface Outbound {
        record Frame(String text) implements Outbound {
        }

        record Close(int code, String reason) implements Outbound {
        }
    }

    private final WsContext ctx;
    private final Codec codec;
    private final BlockingQueue<Outbound> queue = new ArrayBlockingQueue<>(SEND_QUEUE_CAPACITY);
    private final AtomicBoolean closing = new AtomicBoolean();
    private final Thread drainer;
    /** Set by the registry once hello establishes the session; read on Jetty threads for routing. */
    private volatile String userId;

    Conn(WsContext ctx, Codec codec) {
        this.ctx = ctx;
        this.codec = codec;
        this.drainer = Thread.ofVirtual().name("ws-send-" + ctx.sessionId()).start(this::drain);
    }

    void send(ServerMsg msg) {
        if (closing.get()) {
            return;
        }
        if (!queue.offer(new Outbound.Frame(codec.encode(msg)))) {
            log.warn("send queue overflow on {} — closing slow connection", ctx.sessionId());
            close(WsCloseCodes.OVERLOADED, "send queue overflow");
        }
    }

    /** Best-effort send of a final message, then close. */
    void sendAndClose(ServerMsg msg, int code, String reason) {
        send(msg);
        close(code, reason);
    }

    void close(int code, String reason) {
        if (closing.compareAndSet(false, true) && !queue.offer(new Outbound.Close(code, reason))) {
            // Queue jammed — close out of band; Jetty's session close is thread-safe.
            ctx.closeSession(code, reason);
        }
    }

    /** Socket is gone (onClose fired): stop the drainer. */
    void shutdown() {
        closing.set(true);
        drainer.interrupt();
    }

    String id() {
        return ctx.sessionId();
    }

    String userId() {
        return userId;
    }

    void userId(String userId) {
        this.userId = userId;
    }

    private void drain() {
        try {
            while (true) {
                switch (queue.take()) {
                    case Outbound.Frame f -> ctx.send(f.text());
                    case Outbound.Close c -> {
                        ctx.closeSession(c.code(), c.reason());
                        return;
                    }
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            log.debug("send on {} failed — socket presumed dead: {}", ctx.sessionId(), e.toString());
        }
    }
}
