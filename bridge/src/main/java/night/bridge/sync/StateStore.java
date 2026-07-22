package night.bridge.sync;

import com.fasterxml.jackson.databind.JsonNode;
import night.bridge.proto.Json;
import night.bridge.proto.ServerMsg;
import night.bridge.proto.StateKeyframe;
import night.bridge.proto.StatePatch;
import night.bridge.proto.event.GameEvent;
import night.bridge.proto.state.GameState;

import java.util.List;
import java.util.Optional;

/**
 * One seat's canonical trimmed state tree + the seat's event seq counter
 * (protocol §3: one monotonic counter shared by all game.* events, so it
 * lives here and everything the pump emits stamps through it).
 *
 * <p>Keyframe policy (protocol §7): keyframe on the first state, on demand
 * ({@link #forceKeyframe} — resync/reconnect), and after every
 * {@code keyframeEvery}th consecutive patch as a self-healing backstop — the
 * backstop keyframe follows that patch at the next seq with the same tree, so
 * a dev-mode client can deep-verify its patched tree against ground truth
 * (client design §6) as an exact match. Snapshots whose trimmed tree is
 * unchanged emit nothing (§7 empty-diff suppression). {@code keyframesOnly}
 * is the hello {@code stateMode:'keyframes'} debug escape hatch.
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

    public List<ServerMsg> update(String gameId, GameState state, boolean keyframesOnly) {
        return update(gameId, state, keyframesOnly, null);
    }

    /**
     * Empty when the trimmed tree is unchanged from the last emitted one; the
     * patch plus the same-tree backstop keyframe when the backstop fires. The
     * derived §7.1 {@code events} ride on the message that carries the
     * transition — the patch, or the first keyframe of the game — never on the
     * backstop keyframe (it only restates the tree the patch already produced).
     */
    public List<ServerMsg> update(String gameId, GameState state, boolean keyframesOnly,
                                  List<GameEvent> events) {
        JsonNode tree = Json.tree(state);
        if (tree.equals(lastTree)) {
            return List.of();
        }
        List<GameEvent> hints = emptyToNull(events);
        if (lastTree == null || keyframesOnly) {
            return List.of(keyframe(gameId, tree, hints));
        }
        JsonNode ops = Differ.diff(lastTree, tree);
        lastTree = tree;
        patchesSinceKeyframe++;
        long base = lastStateSeq;
        lastStateSeq = nextSeq();
        StatePatch patch = new StatePatch(lastStateSeq, gameId, base, ops, hints);
        if (patchesSinceKeyframe >= keyframeEvery) {
            return List.of(patch, keyframe(gameId, tree, null));
        }
        return List.of(patch);
    }

    /** Fresh keyframe of the current tree (resync/reconnect); empty before the first state. */
    public Optional<StateKeyframe> forceKeyframe(String gameId) {
        return lastTree == null ? Optional.empty()
                : Optional.of(keyframe(gameId, lastTree, null));
    }

    private StateKeyframe keyframe(String gameId, JsonNode tree, List<GameEvent> events) {
        lastTree = tree;
        patchesSinceKeyframe = 0;
        lastStateSeq = nextSeq();
        return new StateKeyframe(lastStateSeq, gameId, tree, events);
    }

    private static List<GameEvent> emptyToNull(List<GameEvent> events) {
        return events == null || events.isEmpty() ? null : events;
    }
}
