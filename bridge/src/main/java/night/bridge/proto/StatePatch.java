package night.bridge.proto;

import com.fasterxml.jackson.databind.JsonNode;
import night.bridge.proto.event.GameEvent;

import java.util.List;

/**
 * RFC 6902 diff between consecutive trimmed states (protocol §7). {@code base}
 * is the seq the ops apply to — an assertion, not a sync mechanism: a client
 * whose last applied seq differs stops applying and sends {@code game.resync}.
 * {@code ops} is the zjsonpatch output verbatim (add/remove/replace only,
 * design §1). {@code events} are the optional §7.1 animation hints explaining
 * this transition; null (omitted from the wire) when none were derived.
 */
public record StatePatch(
        long seq,
        String gameId,
        long base,
        JsonNode ops,
        List<GameEvent> events) implements ServerMsg {

    public StatePatch(long seq, String gameId, long base, JsonNode ops) {
        this(seq, gameId, base, ops, null);
    }
}
