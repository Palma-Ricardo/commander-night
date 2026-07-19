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

    private static ServerMsg one(List<ServerMsg> msgs) {
        assertEquals(1, msgs.size(), "expected exactly one message, got " + msgs);
        return msgs.get(0);
    }

    @Test
    void firstStateIsAKeyframeAtSeqZero() {
        StateStore store = new StateStore(100);
        ServerMsg msg = one(store.update("g1", state(40), false));
        assertEquals(0, assertInstanceOf(StateKeyframe.class, msg).seq());
    }

    @Test
    void unchangedStateEmitsNothing() {
        StateStore store = new StateStore(100);
        assertEquals(1, store.update("g1", state(40), false).size());
        assertTrue(store.update("g1", state(40), false).isEmpty());
        assertEquals(0, store.lastSeq(), "suppressed states must not burn seq numbers");
        assertEquals(1, store.update("g1", state(39), false).size());
    }

    @Test
    void secondStateIsAPatchThatAppliesBackOntoTheFirst() {
        StateStore store = new StateStore(100);
        store.update("g1", state(40), false);
        JsonNode before = Json.tree(state(40));
        StatePatch patch = assertInstanceOf(StatePatch.class,
                one(store.update("g1", state(37), false)));
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
                one(store.update("g1", state(39), false)));
        assertEquals(3, patch.seq());
        assertEquals(0, patch.base(), "base is the last state event, not seq-1");
    }

    @Test
    void backstopKeyframeFollowsTheNthPatchWithTheSameTree() {
        StateStore store = new StateStore(2);
        int life = 40;
        assertInstanceOf(StateKeyframe.class, one(store.update("g1", state(life--), false)));
        assertInstanceOf(StatePatch.class, one(store.update("g1", state(life--), false)));

        // the keyframeEvery-th patch arrives with its backstop keyframe in tow
        List<ServerMsg> pair = store.update("g1", state(life), false);
        assertEquals(2, pair.size(), "backstop must follow the patch, not replace it");
        StatePatch patch = assertInstanceOf(StatePatch.class, pair.get(0));
        StateKeyframe backstop = assertInstanceOf(StateKeyframe.class, pair.get(1));
        assertEquals(patch.seq() + 1, backstop.seq(), "backstop rides at the next seq");
        assertEquals(Json.tree(state(life--)), backstop.state(),
                "backstop carries exactly the tree the patch stream produces (client §6 verify)");

        // the counter reset — patching resumes, anchored to the backstop
        StatePatch next = assertInstanceOf(StatePatch.class, one(store.update("g1", state(life--), false)));
        assertEquals(backstop.seq(), next.base(), "patches must anchor to the backstop keyframe");
    }

    @Test
    void keyframesOnlyModeNeverPatches() {
        StateStore store = new StateStore(100);
        assertInstanceOf(StateKeyframe.class, one(store.update("g1", state(40), true)));
        assertInstanceOf(StateKeyframe.class, one(store.update("g1", state(39), true)));
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
                one(store.update("g1", state(39), false)));
        assertEquals(1, patch.base(), "patches must anchor to the forced keyframe");
    }

    @Test
    void patchBaseChainsAcrossConsecutivePatches() {
        StateStore store = new StateStore(100);
        store.update("g1", state(40), false);
        StatePatch p1 = assertInstanceOf(StatePatch.class, one(store.update("g1", state(39), false)));
        StatePatch p2 = assertInstanceOf(StatePatch.class, one(store.update("g1", state(38), false)));
        assertEquals(1, p1.seq());
        assertEquals(1, p2.base());
        assertEquals(2, p2.seq());
    }
}
