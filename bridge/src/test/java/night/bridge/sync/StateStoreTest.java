package night.bridge.sync;

import com.fasterxml.jackson.databind.JsonNode;
import com.flipkart.zjsonpatch.JsonPatch;
import night.bridge.proto.Json;
import night.bridge.proto.ServerMsg;
import night.bridge.proto.StateKeyframe;
import night.bridge.proto.StatePatch;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.Phase;
import night.bridge.proto.state.Player;
import night.bridge.proto.state.Step;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

class StateStoreTest {

    private static GameState state(int life) {
        return new GameState("g1", GameState.Status.ACTIVE, true,
                new GameState.Turn(1, Phase.BEGINNING, Step.UPKEEP, "p1", "p1"),
                List.of(new Player("p1", "A", true, life, null,
                        new Player.ManaPool(0, 0, 0, 0, 0, 0), 92, 7,
                        List.of(), List.of(), List.of(), List.of(), null, null, null)),
                List.of(), null, null, null, null);
    }

    @Test
    void firstStateIsAKeyframeAtSeqZero() {
        StateStore store = new StateStore(100);
        ServerMsg msg = store.update("g1", state(40), false).orElseThrow();
        assertEquals(0, assertInstanceOf(StateKeyframe.class, msg).seq());
    }

    @Test
    void unchangedStateEmitsNothing() {
        StateStore store = new StateStore(100);
        assertTrue(store.update("g1", state(40), false).isPresent());
        assertTrue(store.update("g1", state(40), false).isEmpty());
        assertEquals(0, store.lastSeq(), "suppressed states must not burn seq numbers");
        assertTrue(store.update("g1", state(39), false).isPresent());
    }

    @Test
    void secondStateIsAPatchThatAppliesBackOntoTheFirst() {
        StateStore store = new StateStore(100);
        store.update("g1", state(40), false);
        JsonNode before = Json.tree(state(40));
        StatePatch patch = assertInstanceOf(StatePatch.class,
                store.update("g1", state(37), false).orElseThrow());
        assertEquals(0, patch.base(), "patch must anchor to the keyframe's seq");
        assertEquals(1, patch.seq());
        assertEquals(Json.tree(state(37)), JsonPatch.apply(patch.ops(), before),
                "applying the ops onto the previous tree must reproduce the new one");
        for (JsonNode op : patch.ops()) {
            assertTrue(Set.of("add", "remove", "replace").contains(op.path("op").asText()),
                    "only add/remove/replace ops allowed, got " + op);
        }
    }

    @Test
    void baseSkipsInterleavedNonStateEvents() {
        StateStore store = new StateStore(100);
        store.update("g1", state(40), false);            // seq 0 keyframe
        store.nextSeq();                                 // seq 1: e.g. a prompt
        store.nextSeq();                                 // seq 2: e.g. a log line
        StatePatch patch = assertInstanceOf(StatePatch.class,
                store.update("g1", state(39), false).orElseThrow());
        assertEquals(3, patch.seq());
        assertEquals(0, patch.base(), "base is the last state event, not seq-1");
    }

    @Test
    void keyframeEveryNPatchesRollsOver() {
        StateStore store = new StateStore(2);
        int life = 40;
        assertInstanceOf(StateKeyframe.class, store.update("g1", state(life--), false).orElseThrow());
        assertInstanceOf(StatePatch.class, store.update("g1", state(life--), false).orElseThrow());
        assertInstanceOf(StatePatch.class, store.update("g1", state(life--), false).orElseThrow());
        assertInstanceOf(StateKeyframe.class, store.update("g1", state(life--), false).orElseThrow(),
                "the keyframeEvery+1th change must be a keyframe");
        assertInstanceOf(StatePatch.class, store.update("g1", state(life--), false).orElseThrow(),
                "the patch counter must reset after the backstop keyframe");
    }

    @Test
    void keyframesOnlyModeNeverPatches() {
        StateStore store = new StateStore(100);
        assertInstanceOf(StateKeyframe.class, store.update("g1", state(40), true).orElseThrow());
        assertInstanceOf(StateKeyframe.class, store.update("g1", state(39), true).orElseThrow());
    }

    @Test
    void forceKeyframeReEmitsTheCurrentTreeAndAnchorsLaterPatches() {
        StateStore store = new StateStore(100);
        assertTrue(store.forceKeyframe("g1").isEmpty(), "no state yet — nothing to keyframe");
        store.update("g1", state(40), false);
        StateKeyframe kf = store.forceKeyframe("g1").orElseThrow();
        assertEquals(1, kf.seq());
        assertEquals(Json.tree(state(40)), kf.state());
        StatePatch patch = assertInstanceOf(StatePatch.class,
                store.update("g1", state(39), false).orElseThrow());
        assertEquals(1, patch.base(), "patches must anchor to the forced keyframe");
    }

    @Test
    void patchBaseChainsAcrossConsecutivePatches() {
        StateStore store = new StateStore(100);
        store.update("g1", state(40), false);
        Optional<ServerMsg> p1 = store.update("g1", state(39), false);
        Optional<ServerMsg> p2 = store.update("g1", state(38), false);
        assertEquals(1, ((StatePatch) p1.orElseThrow()).seq());
        assertEquals(1, ((StatePatch) p2.orElseThrow()).base());
        assertEquals(2, ((StatePatch) p2.orElseThrow()).seq());
    }
}
