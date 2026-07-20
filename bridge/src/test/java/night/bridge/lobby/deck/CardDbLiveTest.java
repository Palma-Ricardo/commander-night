package night.bridge.lobby.deck;

import mage.cards.repository.CardInfo;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

@Tag("live")
class CardDbLiveTest {

    @Test
    void guardPassesAgainstTheDistDatabase() {
        CardDb.require();
    }

    @Test
    void resolvesAKnownPrinting() {
        CardDb.require();
        CardInfo sol = CardDb.cards().findCard("CMM", "410");
        assertNotNull(sol, "CMM:410 should be Sol Ring");
        assertEquals("Sol Ring", sol.getName());
    }
}
