package night.bridge.game;

import night.bridge.proto.GamePrompt;
import night.bridge.proto.state.Card;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.Phase;
import night.bridge.proto.state.Step;
import night.bridge.translate.Html;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Early mulligan asks (protocol §8): when a seat's hand is ready to be asked about. */
class MulliganWindowTest {

    private static Card card(String id) {
        return new Card(id, "", "C15", "50", null, 0, List.of(), List.of(), List.of(), List.of(),
                List.of(), null, null, null, null, null, null, null, null, null);
    }

    /** A pre-game state whose hand is {@code n} cards named {@code prefix0..}. */
    private static GameState hand(String prefix, int n) {
        List<Card> cards = IntStream.range(0, n).mapToObj(i -> card(prefix + i)).toList();
        return new GameState("g1", GameState.Status.ACTIVE, true,
                new GameState.Turn(0, null, null, null, null),
                List.of(), List.of(), null, List.of(), List.of(),
                new GameState.Me("p1", cards, null));
    }

    private static GameState upkeep() {
        return new GameState("g1", GameState.Status.ACTIVE, true,
                new GameState.Turn(1, Phase.BEGINNING, Step.UPKEEP, "p1", "p1"),
                List.of(), List.of(), null, List.of(), List.of(),
                new GameState.Me("p1", List.of(), null));
    }

    @Test
    void messagesMatchXmagesStrippedText() {
        // HumanPlayer.chooseMulligan's markup, through the same strip PromptTranslator applies
        MulliganWindow w = new MulliganWindow(1);
        assertEquals(Html.strip("Mulligan <font color=#00ff00>for free</font>, draw another 7 cards?"),
                w.message(7));
        w.offer(hand("a", 7));
        w.decided(true);
        assertEquals(Html.strip("Mulligan <font color=#ffff00>down to 6 cards</font>?"), w.message(7));
        assertEquals("Mulligan down to 1 card?", w.message(2));
    }

    @Test
    void offersAFullHandOnceAndNotAnEmptyOne() {
        MulliganWindow w = new MulliganWindow(1);
        assertNull(w.offer(hand("a", 0)), "GAME_INIT arrives before the hands are drawn");
        assertEquals("Mulligan for free, draw another 7 cards?", w.offer(hand("a", 7)));
        assertNull(w.offer(hand("a", 7)), "the same hand is never offered twice");
    }

    @Test
    void freeMulliganReoffersTheRedrawnSevenRightAway() {
        MulliganWindow w = new MulliganWindow(1);
        w.offer(hand("a", 7));
        w.decided(true);
        assertNull(w.offer(hand("a", 7)), "XMage hasn't redrawn yet");
        assertNull(w.offer(hand("b", 3)), "not a whole hand");
        assertEquals("Mulligan down to 6 cards?", w.offer(hand("b", 7)));
    }

    @Test
    void paidMulliganWaitsUntilTheBottomingIsDone() {
        MulliganWindow w = new MulliganWindow(1);
        w.offer(hand("a", 7));
        w.decided(true);           // free: 7 → 7
        w.offer(hand("b", 7));
        w.decided(true);           // paid: 7 → 6
        assertNull(w.offer(hand("c", 7)), "the new 7 still has a card to bottom");
        assertEquals("Mulligan down to 5 cards?", w.offer(hand("c", 6)));
    }

    @Test
    void withoutAFreeMulliganTheFirstIsPaid() {
        MulliganWindow w = new MulliganWindow(0);
        assertEquals("Mulligan down to 6 cards?", w.offer(hand("a", 7)));
        w.decided(true);
        assertNull(w.offer(hand("b", 7)));
        assertEquals("Mulligan down to 5 cards?", w.offer(hand("b", 6)));
    }

    @Test
    void keepingEndsTheOffers() {
        MulliganWindow w = new MulliganWindow(1);
        w.offer(hand("a", 7));
        w.decided(false);
        assertNull(w.offer(hand("b", 7)));
    }

    @Test
    void aRealAskPinsItsHandAndAWithdrawalFreesIt() {
        MulliganWindow w = new MulliganWindow(1);
        w.asked(hand("a", 7));     // the starting player: XMage asks before any early offer
        assertNull(w.offer(hand("a", 7)));
        w.withdrawn();
        assertEquals("Mulligan for free, draw another 7 cards?", w.offer(hand("a", 7)));
    }

    @Test
    void closesOnceWhenTheFirstTurnBegins() {
        MulliganWindow w = new MulliganWindow(1);
        assertFalse(w.closesOn(hand("a", 7)));
        assertTrue(w.open());
        assertTrue(w.closesOn(upkeep()));
        assertFalse(w.closesOn(upkeep()), "reported once");
        assertFalse(w.open());
        assertNull(w.offer(hand("b", 7)));
    }

    @Test
    void recognizesXmagesMulliganButtons() {
        assertTrue(MulliganWindow.isMulliganAsk(GamePrompt.confirm(1, "Mulligan down to 6 cards?", "Mulligan", "Keep")));
        assertFalse(MulliganWindow.isMulliganAsk(GamePrompt.confirm(1, "Pay 2 life?", null, null)));
    }
}
