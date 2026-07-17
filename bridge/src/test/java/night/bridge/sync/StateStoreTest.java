package night.bridge.sync;

import night.bridge.proto.StateKeyframe;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.Phase;
import night.bridge.proto.state.Player;
import night.bridge.proto.state.Step;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class StateStoreTest {

    private static GameState state(int life) {
        return new GameState("g1", GameState.Status.ACTIVE,
                new GameState.Turn(1, Phase.BEGINNING, Step.UPKEEP, "p1", "p1"),
                List.of(new Player("p1", "A", true, life, null,
                        new Player.ManaPool(0, 0, 0, 0, 0, 0), 92, 7,
                        List.of(), List.of(), List.of(), List.of(), null, null, null)),
                List.of(), null, null, null, null);
    }

    @Test
    void firstKeyframeIsSeqZero() {
        StateStore store = new StateStore();
        Optional<StateKeyframe> kf = store.keyframe("g1", state(40));
        assertEquals(0, kf.orElseThrow().seq());
    }

    @Test
    void unchangedStateEmitsNothing() {
        StateStore store = new StateStore();
        assertTrue(store.keyframe("g1", state(40)).isPresent());
        assertTrue(store.keyframe("g1", state(40)).isEmpty());
        assertEquals(0, store.lastSeq(), "suppressed keyframes must not burn seq numbers");
        assertTrue(store.keyframe("g1", state(39)).isPresent());
    }

    @Test
    void seqIsSharedAndGaplessAcrossEventKinds() {
        StateStore store = new StateStore();
        assertEquals(0, store.keyframe("g1", state(40)).orElseThrow().seq());
        assertEquals(1, store.nextSeq());     // e.g. a prompt
        assertEquals(2, store.nextSeq());     // e.g. a log line
        assertEquals(3, store.keyframe("g1", state(39)).orElseThrow().seq());
    }
}
