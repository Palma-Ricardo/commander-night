package night.bridge.proto;

import com.fasterxml.jackson.databind.JsonNode;
import night.bridge.proto.event.GameEvent;

import java.util.List;

/**
 * Full state snapshot (protocol §7). {@code state} is carried as the already
 * trimmed tree — the StateStore's canonical JsonNode — so what we diff (M3)
 * and what we send are byte-identical by construction. {@code events} are the
 * optional §7.1 animation hints; null (omitted from the wire) on a keyframe
 * that describes no transition — resync, reconnect, and the backstop keyframe
 * that merely restates the tree a patch already carried.
 */
public record StateKeyframe(
        long seq,
        String gameId,
        JsonNode state,
        List<GameEvent> events) implements ServerMsg {

    public StateKeyframe(long seq, String gameId, JsonNode state) {
        this(seq, gameId, state, null);
    }
}
