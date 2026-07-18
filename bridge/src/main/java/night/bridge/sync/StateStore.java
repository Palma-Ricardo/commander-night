package night.bridge.sync;

import com.fasterxml.jackson.databind.JsonNode;
import night.bridge.proto.Json;
import night.bridge.proto.ServerMsg;
import night.bridge.proto.StateKeyframe;
import night.bridge.proto.StatePatch;
import night.bridge.proto.state.GameState;

import java.util.Optional;

/**
 * One seat's canonical trimmed state tree + the seat's event seq counter
 * (protocol §3: one monotonic counter shared by all game.* events, so it
 * lives here and everything the pump emits stamps through it).
 *
 * <p>Keyframe policy (protocol §7): keyframe on the first state, on demand
 * ({@link #forceKeyframe} — resync/reconnect), and instead of every
 * {@code keyframeEvery}+1th consecutive patch as a self-healing backstop;
 * a patch otherwise. Snapshots whose trimmed tree is unchanged emit nothing
 * (§7 empty-diff suppression). {@code keyframesOnly} is the hello
 * {@code stateMode:'keyframes'} debug escape hatch.
 *
 * <p>{@code base} on a patch is the seq of the previous state-carrying event
 * (keyframe or patch) — other event kinds interleave on the same counter, so
 * it is not simply {@code seq - 1}.
 *
 * <p>Owned by the seat pump; not thread-safe by design (design §4).
 */
public final class StateStore {

    private final int keyframeEvery;
    private long seq = -1;
    private JsonNode lastTree;
    private long lastStateSeq = -1;
    private int patchesSinceKeyframe;

    public StateStore(int keyframeEvery) {
        this.keyframeEvery = keyframeEvery;
    }

    /** Next event seq; first event of a game is 0 (protocol §7). */
    public long nextSeq() {
        return ++seq;
    }

    public long lastSeq() {
        return seq;
    }

    /** Empty when the trimmed tree is unchanged from the last emitted one. */
    public Optional<ServerMsg> update(String gameId, GameState state, boolean keyframesOnly) {
        JsonNode tree = Json.tree(state);
        if (tree.equals(lastTree)) {
            return Optional.empty();
        }
        if (lastTree == null || keyframesOnly || patchesSinceKeyframe >= keyframeEvery) {
            return Optional.of(keyframe(gameId, tree));
        }
        JsonNode ops = Differ.diff(lastTree, tree);
        lastTree = tree;
        patchesSinceKeyframe++;
        long base = lastStateSeq;
        lastStateSeq = nextSeq();
        return Optional.of(new StatePatch(lastStateSeq, gameId, base, ops));
    }

    /** Fresh keyframe of the current tree (resync/reconnect); empty before the first state. */
    public Optional<StateKeyframe> forceKeyframe(String gameId) {
        return lastTree == null ? Optional.empty()
                : Optional.of(keyframe(gameId, lastTree));
    }

    private StateKeyframe keyframe(String gameId, JsonNode tree) {
        lastTree = tree;
        patchesSinceKeyframe = 0;
        lastStateSeq = nextSeq();
        return new StateKeyframe(lastStateSeq, gameId, tree);
    }
}
