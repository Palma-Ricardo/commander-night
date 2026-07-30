package night.bridge.translate;

import night.bridge.proto.state.GameState.Me.Skip;
import org.junit.jupiter.api.Test;

import static night.bridge.translate.ViewTranslator.skipOf;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Protocol §6 {@code me.skip} from PlayerView's five reachable skip flags.
 * The golden fixtures can't cover this — the live auto-players pass priority
 * per-prompt and never arm a skip — so the flag→mode mapping is pinned here.
 */
class ViewTranslatorTest {

    @Test
    void noFlagsMeansNoSkip() {
        assertNull(skipOf(false, false, false, false, false));
    }

    @Test
    void eachFlagMapsToItsMode() {
        assertEquals(Skip.STACK, skipOf(true, false, false, false, false));
        assertEquals(Skip.END_OF_TURN, skipOf(false, true, false, false, false));
        assertEquals(Skip.NEXT_MAIN, skipOf(false, false, true, false, false));
        assertEquals(Skip.MY_NEXT_TURN, skipOf(false, false, false, true, false));
        assertEquals(Skip.END_STEP_BEFORE_MY_TURN, skipOf(false, false, false, false, true));
    }

    @Test
    void wireValuesMatchProtocolSection9ModeNames() {
        assertEquals("stack", Skip.STACK.wire());
        assertEquals("endOfTurn", Skip.END_OF_TURN.wire());
        assertEquals("nextMain", Skip.NEXT_MAIN.wire());
        assertEquals("myNextTurn", Skip.MY_NEXT_TURN.wire());
        assertEquals("endStepBeforeMyTurn", Skip.END_STEP_BEFORE_MY_TURN.wire());
    }

    /** StackAbilityView/CardsView append "Related objects: …" — a log-render of the
     *  ability's targets, which StackItem.targets already carries (the client draws
     *  arrows). It is presentation noise and overflowed every text box (#28). */
    @Test
    void relatedObjectsLinesAreStrippedFromRulesText() {
        assertEquals(
                java.util.List.of("When this creature attacks, draw a card."),
                ViewTranslator.rules(java.util.List.of(
                        "When this creature attacks, draw a card.",
                        "<i>Related objects: <font object_id='abc'>Sol Ring</font> [abc]</i>")));
    }
}
