package night.bridge.proto;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Full state snapshot (protocol §7). {@code state} is carried as the already
 * trimmed tree — the StateStore's canonical JsonNode — so what we diff (M3)
 * and what we send are byte-identical by construction.
 */
public record StateKeyframe(
        long seq,
        String gameId,
        JsonNode state) implements ServerMsg {
}
