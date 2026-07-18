package night.bridge.proto;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * RFC 6902 diff between consecutive trimmed states (protocol §7). {@code base}
 * is the seq the ops apply to — an assertion, not a sync mechanism: a client
 * whose last applied seq differs stops applying and sends {@code game.resync}.
 * {@code ops} is the zjsonpatch output verbatim (add/remove/replace only,
 * design §1).
 */
public record StatePatch(
        long seq,
        String gameId,
        long base,
        JsonNode ops) implements ServerMsg {
}
