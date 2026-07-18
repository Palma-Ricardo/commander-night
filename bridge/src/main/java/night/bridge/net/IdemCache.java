package night.bridge.net;

import night.bridge.proto.ServerMsg;

import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * Per-session command idempotency (protocol §14): an LRU of recent command
 * ids → their final reply. A retried command re-sends the recorded reply
 * without re-executing; a duplicate racing its still-executing original is
 * dropped (the original's reply is coming). Thread-safe the boring way:
 * checked on Jetty threads, completed on the lobby/pump executors, and every
 * operation is a few map touches under one lock.
 */
final class IdemCache {

    static final int CAPACITY = 64;

    sealed interface Check {
        /** First sighting — execute, and complete() with the reply. */
        record Proceed() implements Check {
        }

        /** The original is still executing — drop this duplicate. */
        record InFlight() implements Check {
        }

        /** Already executed — re-send this recorded reply. */
        record Replay(ServerMsg reply) implements Check {
        }
    }

    private final Set<String> inFlight = new HashSet<>();
    private final LinkedHashMap<String, ServerMsg> done =
            new LinkedHashMap<>(CAPACITY * 2, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, ServerMsg> eldest) {
                    return size() > CAPACITY;
                }
            };

    synchronized Check check(String id) {
        ServerMsg reply = done.get(id);
        if (reply != null) {
            return new Check.Replay(reply);
        }
        return inFlight.add(id) ? new Check.Proceed() : new Check.InFlight();
    }

    synchronized void complete(String id, ServerMsg reply) {
        inFlight.remove(id);
        done.put(id, reply);
    }
}
