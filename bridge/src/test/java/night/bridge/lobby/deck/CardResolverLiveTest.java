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

    /**
     * Step 2: right set, wrong number — warn and use another printing from that
     * set, deterministically. CMM carries two real Sol Ring printings, 410 and
     * 703 (confirmed against the live database — see task-8-report.md, "Fix
     * round 1"); the tiebreak in {@code CardResolver} picks the lowest collector
     * number, so this must resolve to 410 every time, not whichever printing
     * {@code CardRepository#findCards} happens to return first.
     */
    @Test
    void wrongNumberFallsBackWithinTheSet() {
        CardResolver.Resolved r = CardResolver.resolve(line("Sol Ring", "CMM", "99999"));
        assertNotNull(r.card());
        assertEquals("CMM", r.card().getSetCode());
        assertEquals("410", r.card().getCardNumber());
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

    /**
     * A literal slash in a real card name must survive. XMage's split heuristic (and
     * so {@link CardResolver#normalize}) rewrites the bare "/" to " // ", producing the
     * nonexistent "Summon: Choco // Mog" — XMage's own importer can't load this FIN
     * card for that reason. The resolver retries the name as written when the split
     * form misses, so it resolves both as a bare name and with its printing.
     */
    @Test
    void literalSlashInNameResolves() {
        CardResolver.Resolved bare = CardResolver.resolve(line("Summon: Choco/Mog", null, null));
        assertNotNull(bare.card(), () -> String.valueOf(bare.problem()));
        assertEquals("Summon: Choco/Mog", bare.card().getName());

        CardResolver.Resolved printed = CardResolver.resolve(line("Summon: Choco/Mog", "FIN", "35"));
        assertNotNull(printed.card(), () -> String.valueOf(printed.problem()));
        assertEquals("Summon: Choco/Mog", printed.card().getName());
        assertEquals("FIN", printed.card().getSetCode());
        assertEquals("35", printed.card().getCardNumber());
    }

    /**
     * 1.4.63's "SP//dr, Piloted by Peni" (SPM) has a literal <em>spaceless</em>
     * "//" — the split-card respacing that every other form applies turns it into
     * the nonexistent "SP // dr, …". The verbatim fallback must find it.
     */
    @Test
    void spacelessDoubleSlashInNameResolves() {
        CardResolver.Resolved bare = CardResolver.resolve(line("SP//dr, Piloted by Peni", null, null));
        assertNotNull(bare.card(), () -> String.valueOf(bare.problem()));
        assertEquals("SP//dr, Piloted by Peni", bare.card().getName());

        CardResolver.Resolved printed = CardResolver.resolve(line("SP//dr, Piloted by Peni", "SPM", "147"));
        assertNotNull(printed.card(), () -> String.valueOf(printed.problem()));
        assertEquals("SPM", printed.card().getSetCode());
        assertEquals("147", printed.card().getCardNumber());
        assertNull(printed.warning());
    }

    /**
     * WotC's Universes Beyond bonus sheets reprint classic cards under new flavour
     * names/art (FF's "Through the Ages", set FCA). XMage files them under the
     * <em>original</em> card name, so the flavour name misses — but the set code +
     * collector number the deck carries identify the printing exactly. Resolve by
     * printing, warn about the substitution, keep the deck importable.
     */
    @Test
    void functionalReprintResolvesByPrinting() {
        // "Zidane Tribal" (FCA 43) is XMage's "Ragavan, Nimble Pilferer".
        CardResolver.Resolved zidane = CardResolver.resolve(line("Zidane Tribal", "FCA", "43"));
        assertNotNull(zidane.card(), () -> String.valueOf(zidane.problem()));
        assertEquals("Ragavan, Nimble Pilferer", zidane.card().getName());
        assertEquals("FCA", zidane.card().getSetCode());
        assertNotNull(zidane.warning());
        assertTrue(zidane.warning().contains("Zidane Tribal"), zidane.warning());
        assertTrue(zidane.warning().contains("Ragavan"), zidane.warning());

        // "A Promise Fulfilled" (FCA 39) is "Light Up the Stage".
        CardResolver.Resolved promise = CardResolver.resolve(line("A Promise Fulfilled", "FCA", "39"));
        assertNotNull(promise.card(), () -> String.valueOf(promise.problem()));
        assertEquals("Light Up the Stage", promise.card().getName());
    }

    /**
     * The printing fallback must not paper over a genuinely unknown card: a bad name
     * with a printing that does not exist stays a hard error.
     */
    @Test
    void unknownNameWithUnknownPrintingStillFails() {
        CardResolver.Resolved r = CardResolver.resolve(line("Not A Real Card", "FCA", "99999"));
        assertNull(r.card());
        assertNotNull(r.problem());
        assertTrue(r.problem().contains("Not A Real Card"), r.problem());
    }

    @Test
    void aMisspellingIsAHardError() {
        CardResolver.Resolved r = CardResolver.resolve(line("Sol Rong", null, null));
        assertNull(r.card());
        assertNotNull(r.problem());
        assertTrue(r.problem().contains("Sol Rong"), r.problem());
    }
}
