package night.bridge.game;

import night.bridge.proto.GamePrompt;
import night.bridge.proto.state.Card;
import night.bridge.proto.state.GameState;

import java.util.Set;
import java.util.stream.Collectors;

/**
 * One seat's view of the pre-game mulligan window, used to ask early (protocol §8,
 * "Mulligans are asked concurrently"). XMage's {@code Mulligan.executeMulliganPhase}
 * asks seats one at a time in turn order and blocks on each answer, but a seat's hand
 * is final well before XMage reaches it. Tap X9HA8P: the human seat held its 7 cards
 * while three AI seats were asked ahead of it. This class decides when a seat's hand is
 * ready for its next keep-or-mulligan question, so the pump can show that question early
 * and hold the answer.
 *
 * <p>A hand is ready when (a) we're in the pre-game window (no {@code turn.step}),
 * (b) it isn't the hand this seat last decided on, and (c) it has the size the last
 * mulligan should leave. (c) matters because XMage draws a full new hand before asking
 * for the cards to bottom. A paid mulligan's 7-card hand isn't final until the bottoming
 * {@code chooseTargets} asks are answered. The free mulligan (CR 103.5c,
 * {@link night.bridge.xmage.TableRecipe#FREE_MULLIGANS}) has no bottoming.
 *
 * <p>Every miss degrades to the old behavior: XMage's own ask arrives in turn order and
 * is shown normally. Pump-thread only (design §4).
 */
final class MulliganWindow {

    static final String YES_TEXT = "Mulligan";
    static final String NO_TEXT = "Keep";

    private final int freeMulligans;
    private boolean closed;
    private boolean kept;
    private int taken;
    /** The hand the seat's latest keep-or-mulligan question was about. */
    private Set<String> askedHand = Set.of();
    /** What the hand should hold once the latest mulligan finishes; null before any. */
    private Integer expectedSize;

    MulliganWindow(int freeMulligans) {
        this.freeMulligans = freeMulligans;
    }

    /** XMage's mulligan ask: {@code HumanPlayer.chooseMulligan} labels its buttons Mulligan/Keep. */
    static boolean isMulliganAsk(GamePrompt prompt) {
        return prompt.kind() == GamePrompt.Kind.CONFIRM
                && YES_TEXT.equals(prompt.yesText()) && NO_TEXT.equals(prompt.noText());
    }

    boolean open() {
        return !closed;
    }

    /**
     * Folds in a new state. Returns true exactly once, when the window closes (the first
     * turn has a step, or the game ended), so the pump can withdraw anything early.
     */
    boolean closesOn(GameState state) {
        if (closed || state == null) {
            return false;
        }
        boolean preGame = state.status() == GameState.Status.ACTIVE
                && (state.turn() == null || state.turn().step() == null);
        if (!preGame) {
            closed = true;
            return true;
        }
        return false;
    }

    /**
     * The early question for this hand, or null when it isn't ready. A non-null result
     * counts as asked, so the same hand isn't offered twice.
     */
    String offer(GameState state) {
        if (closed || kept) {
            return null;
        }
        Set<String> hand = hand(state);
        if (hand.isEmpty() || hand.equals(askedHand)
                || (expectedSize != null && hand.size() != expectedSize)) {
            return null;
        }
        askedHand = hand;
        return message(hand.size());
    }

    /** XMage asked for real. Pins the hand it's about, whether or not we offered it early. */
    void asked(GameState state) {
        askedHand = hand(state);
    }

    /** An early offer was withdrawn unanswered (superseded). The same hand may be offered again. */
    void withdrawn() {
        askedHand = Set.of();
    }

    /** A decision reached XMage. Sets up what the next ready hand looks like. */
    void decided(boolean mulligan) {
        if (!mulligan) {
            kept = true;
            return;
        }
        // LondonMulligan.mulligan: a free mulligan redraws the same size, a paid one is one smaller
        expectedSize = taken < freeMulligans ? askedHand.size() : askedHand.size() - 1;
        taken++;
    }

    /** XMage's own text for this ask, as {@code HumanPlayer.chooseMulligan} builds it (HTML stripped). */
    String message(int handSize) {
        if (taken < freeMulligans) {
            return "Mulligan for free, draw another " + cards(handSize) + "?";
        }
        return "Mulligan down to " + cards(handSize - 1) + "?";
    }

    private static String cards(int n) {
        return n + (n == 1 ? " card" : " cards");
    }

    private static Set<String> hand(GameState state) {
        if (state == null || state.me() == null || state.me().hand() == null) {
            return Set.of();
        }
        return state.me().hand().stream().map(Card::id).collect(Collectors.toUnmodifiableSet());
    }
}
