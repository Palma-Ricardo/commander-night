package night.bridge.sync;

import com.fasterxml.jackson.databind.JsonNode;
import night.bridge.proto.Json;
import night.bridge.proto.StateKeyframe;
import night.bridge.proto.state.GameState;

import java.util.Optional;

/**
 * One seat's canonical trimmed state tree + the seat's event seq counter
 * (protocol §3: one monotonic counter shared by all game.* events, so it
 * lives here and everything the pump emits stamps through it).
 *
 * <p>M2 is keyframes-only (design §14): every state change emits a full
 * keyframe; snapshots whose trimmed tree is unchanged emit nothing — the
 * equality check is the keyframe-mode equivalent of §7 empty-diff
 * suppression. The Differ/KeyframePolicy pair replaces this in M3.
 *
 * <p>Owned by the seat pump; not thread-safe by design (design §4).
 */
public final class StateStore {

    private long seq = -1;
    private JsonNode lastTree;

    /** Next event seq; first event of a game is 0 (protocol §7). */
    public long nextSeq() {
        return ++seq;
    }

    public long lastSeq() {
        return seq;
    }

    /** Empty when the trimmed tree is unchanged from the last emitted one. */
    public Optional<StateKeyframe> keyframe(String gameId, GameState state) {
        JsonNode tree = Json.tree(state);
        if (tree.equals(lastTree)) {
            return Optional.empty();
        }
        lastTree = tree;
        return Optional.of(new StateKeyframe(nextSeq(), gameId, tree));
    }
}
