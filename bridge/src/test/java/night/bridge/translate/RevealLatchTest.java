package night.bridge.translate;

import night.bridge.proto.state.Card;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.NamedCards;
import night.bridge.proto.state.Phase;
import night.bridge.proto.state.Player;
import night.bridge.proto.state.Step;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

class RevealLatchTest {

    private static Card card(String id) {
        return new Card(id, "", "C15", "50", null, 0, List.of(), List.of(), List.of(), List.of(),
                List.of(), null, null, null, null, null, null, null, null, null);
    }

    private static Player player(String id, Card topCard) {
        return new Player(id, "A", true, 40, null,
                new Player.ManaPool(0, 0, 0, 0, 0, 0), 92, 7,
                List.of(), List.of(), List.of(), List.of(), null, null, null, topCard);
    }

    private static GameState state(List<NamedCards> revealed, List<NamedCards> lookedAt) {
        return state(revealed, lookedAt, player("p1", null));
    }

    private static GameState state(List<NamedCards> revealed, List<NamedCards> lookedAt, Player me) {
        return new GameState("g1", GameState.Status.ACTIVE, true,
                new GameState.Turn(1, Phase.BEGINNING, Step.UPKEEP, "p1", "p1"),
                List.of(me), List.of(), null, revealed, lookedAt,
                new GameState.Me("p1", List.of(), null));
    }

    @Test
    void windowSurvivesStatesThatLackIt() {
        RevealLatch latch = new RevealLatch();
        latch.apply(state(List.of(new NamedCards("Windfall", List.of(card("c1")))), null));
        GameState out = null;
        for (int i = 0; i < RevealLatch.MISS_LIMIT - 1; i++) {
            out = latch.apply(state(null, null));
        }
        assertNotNull(out.revealed(), "window must outlive stateless views inside the miss budget");
        assertEquals("Windfall", out.revealed().getFirst().name());
    }

    @Test
    void windowDropsAfterMissLimitConsecutiveAbsences() {
        RevealLatch latch = new RevealLatch();
        latch.apply(state(List.of(new NamedCards("Windfall", List.of(card("c1")))), null));
        GameState out = null;
        for (int i = 0; i < RevealLatch.MISS_LIMIT; i++) {
            out = latch.apply(state(null, null));
        }
        assertNull(out.revealed(), "unconfirmed for MISS_LIMIT views — gone");
    }

    @Test
    void reconfirmationResetsTheMissCountAndRefreshesContent() {
        RevealLatch latch = new RevealLatch();
        latch.apply(state(List.of(new NamedCards("Windfall", List.of(card("c1")))), null));
        for (int i = 0; i < RevealLatch.MISS_LIMIT - 1; i++) {
            latch.apply(state(null, null));
        }
        // re-confirmed with new content just before expiry…
        latch.apply(state(List.of(new NamedCards("Windfall", List.of(card("c2")))), null));
        GameState out = null;
        for (int i = 0; i < RevealLatch.MISS_LIMIT - 1; i++) {
            out = latch.apply(state(null, null));
        }
        assertNotNull(out.revealed(), "the miss budget restarts on every confirmation");
        assertEquals("c2", out.revealed().getFirst().cards().getFirst().id());
    }

    @Test
    void ownTopCardWindowFoldsIntoPlayerTopCard() {
        RevealLatch latch = new RevealLatch();
        GameState out = latch.apply(state(null,
                List.of(new NamedCards(RevealLatch.TOP_CARD_WINDOW, List.of(card("top1"))))));
        assertNull(out.lookedAt(), "the folded window must not double-render as a fan");
        assertEquals("top1", out.players().getFirst().topCard().id());
        // …and it persists like any latched window
        out = latch.apply(state(null, null));
        assertEquals("top1", out.players().getFirst().topCard().id());
    }

    @Test
    void realTopCardWinsOverTheFold() {
        RevealLatch latch = new RevealLatch();
        GameState out = latch.apply(state(null,
                List.of(new NamedCards(RevealLatch.TOP_CARD_WINDOW, List.of(card("look")))),
                player("p1", card("public"))));
        assertEquals("public", out.players().getFirst().topCard().id());
    }

    @Test
    void multiCardTopWindowStaysALookedAtWindow() {
        // Never seen from LookAtTopCardOfLibraryAnyTimeEffect, but a same-named
        // multi-card window must not fold a stack of cards onto the pile top.
        RevealLatch latch = new RevealLatch();
        GameState out = latch.apply(state(null,
                List.of(new NamedCards(RevealLatch.TOP_CARD_WINDOW, List.of(card("a"), card("b"))))));
        assertNull(out.players().getFirst().topCard());
        assertEquals(2, out.lookedAt().getFirst().cards().size());
    }

    @Test
    void otherLookedAtWindowsPassThroughBesideTheFold() {
        RevealLatch latch = new RevealLatch();
        GameState out = latch.apply(state(null, List.of(
                new NamedCards(RevealLatch.TOP_CARD_WINDOW, List.of(card("top1"))),
                new NamedCards("Scroll Rack", List.of(card("s1"), card("s2"))))));
        assertEquals("top1", out.players().getFirst().topCard().id());
        assertEquals(1, out.lookedAt().size());
        assertEquals("Scroll Rack", out.lookedAt().getFirst().name());
    }
}
