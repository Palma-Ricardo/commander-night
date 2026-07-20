package night.bridge.lobby.deck;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

@Tag("live")
class CardResolverLiveTest {

    private static DeckLine line(String name, String set, String num) {
        return new DeckLine(1, name, set, num, DeckLine.Section.MAIN, 1);
    }

    /** Step 1: exact set + number, no diagnostic. */
    @Test
    void exactPrintingResolvesCleanly() {
        CardResolver.Resolved r = CardResolver.resolve(line("Sol Ring", "CMM", "410"));
        assertNotNull(r.card());
        assertEquals("Sol Ring", r.card().getName());
        assertEquals("CMM", r.card().getSetCode());
        assertEquals("410", r.card().getCardNumber());
        assertNull(r.warning());
    }

    /** Step 2: right set, wrong number — warn and use another printing from that set. */
    @Test
    void wrongNumberFallsBackWithinTheSet() {
        CardResolver.Resolved r = CardResolver.resolve(line("Sol Ring", "CMM", "99999"));
        assertNotNull(r.card());
        assertEquals("CMM", r.card().getSetCode());
        assertNotNull(r.warning());
        assertTrue(r.warning().contains("Sol Ring"), r.warning());
    }

    /** Step 3: Moxfield emits Scryfall set codes XMage does not have. */
    @Test
    void unknownSetFallsBackToPreferredPrinting() {
        CardResolver.Resolved r = CardResolver.resolve(line("Aura of Silence", "PLST", "C15-60"));
        assertNotNull(r.card());
        assertEquals("Aura of Silence", r.card().getName());
        assertNotNull(r.warning());
        assertTrue(r.warning().contains("PLST"), r.warning());
    }

    /** .mtgo lines carry no set or number at all. */
    @Test
    void bareNameUsesThePreferredPrinting() {
        CardResolver.Resolved r = CardResolver.resolve(line("Anointed Procession", null, null));
        assertNotNull(r.card());
        assertEquals("Anointed Procession", r.card().getName());
        assertNull(r.warning());
    }

    /** Single-slash split names must be normalised or lookup misses. */
    @Test
    void normalisesSplitCardNames() {
        assertEquals("Coward // Killer", CardResolver.normalize("Coward / Killer"));
        assertEquals("Gallifrey Falls // No More", CardResolver.normalize("Gallifrey Falls / No More"));
        CardResolver.Resolved r = CardResolver.resolve(line("Coward / Killer", null, null));
        assertNotNull(r.card(), () -> String.valueOf(r.problem()));
    }

    @Test
    void aMisspellingIsAHardError() {
        CardResolver.Resolved r = CardResolver.resolve(line("Sol Rong", null, null));
        assertNull(r.card());
        assertNotNull(r.problem());
        assertTrue(r.problem().contains("Sol Rong"), r.problem());
    }
}
