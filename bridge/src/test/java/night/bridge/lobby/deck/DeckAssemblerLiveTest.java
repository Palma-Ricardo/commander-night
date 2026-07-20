package night.bridge.lobby.deck;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

@Tag("live")
class DeckAssemblerLiveTest {

    private static DeckImport importOf(String fixture) {
        String text = Fixtures.read(fixture);
        DeckFormat format = DeckFormat.sniff(text);
        ParsedLines lines = switch (format) {
            case DCK -> DckLines.parse(text);
            case MTGO -> MtgoLines.parse(text);
            case MOXFIELD -> MoxfieldLines.parse(text);
        };
        return DeckAssembler.assemble(format, lines);
    }

    /** Moxfield hides the partner pair; only the validators can find it. */
    @Test
    void detectsAPartnerPairInMoxfield() {
        DeckImport d = importOf("timey_wimey.moxfield");
        assertTrue(d.valid(), () -> String.valueOf(d.problems()));
        assertEquals(List.of("Rose Tyler", "The Tenth Doctor"), d.commander());
        assertEquals(2, d.deck().getSideboard().size());
        assertEquals(98, d.deck().getCards().size());
    }

    /** A commander followed by an ordinary card must NOT become a pair. */
    @Test
    void doesNotInventAPartnerPair() {
        DeckImport d = importOf("enduring_enchantments.moxfield");
        assertTrue(d.valid(), () -> String.valueOf(d.problems()));
        assertEquals(List.of("Anikthea, Hand of Erebos"), d.commander());
        assertEquals(99, d.deck().getCards().size());
    }

    @Test
    void discardedSectionBecomesAWarningNotAProblem() {
        DeckImport d = importOf("counter_intelligence.moxfield");
        assertTrue(d.valid(), () -> String.valueOf(d.problems()));
        assertEquals(1, d.warnings().stream().filter(w -> w.contains("SIDEBOARD:")).count(),
                () -> String.valueOf(d.warnings()));
        assertTrue(d.warnings().stream().anyMatch(w -> w.contains("25")),
                () -> String.valueOf(d.warnings()));
    }

    /**
     * The suite's sharpest assertion: .mtgo states the commander count
     * structurally, .moxfield must infer it. Agreement checks the inference
     * against independent ground truth (deck-import spec §8).
     */
    @Test
    void bothFormatsOfTheSameDeckAgree() {
        for (String deck : List.of("enduring_enchantments", "counter_intelligence", "timey_wimey")) {
            DeckImport mtgo = importOf(deck + ".mtgo");
            DeckImport mox = importOf(deck + ".moxfield");
            assertTrue(mtgo.valid(), () -> deck + ".mtgo: " + mtgo.problems());
            assertTrue(mox.valid(), () -> deck + ".moxfield: " + mox.problems());
            assertEquals(100, mtgo.cards(), deck + ".mtgo card count");
            assertEquals(100, mox.cards(), deck + ".moxfield card count");
            assertEquals(mtgo.commander(), mox.commander(), deck + ": commanders disagree");
            assertEquals(names(mtgo), names(mox), deck + ": deck contents disagree");
        }
    }

    private static List<String> names(DeckImport d) {
        return d.deck().getCards().stream().map(c -> c.getCardName()).sorted().toList();
    }

    @Test
    void rejectsAShortDeck() {
        DeckImport d = DeckAssembler.assemble(DeckFormat.MTGO,
                MtgoLines.parse("1 Sol Ring\n\n1 Anikthea, Hand of Erebos\n"));
        assertFalse(d.valid());
        assertTrue(d.problems().stream().anyMatch(p -> p.contains("100")),
                () -> String.valueOf(d.problems()));
    }

    /**
     * The old {@code DeckParserTest.missingCommanderIsAProblem} pinned a zero-commander
     * deck as invalid; Task 7 deliberately did not port that coverage because this
     * suite was meant to own it (deck-import spec §8). A single 100-card stanza with no
     * commander section is a legal card *count* — main + side already sums to 100 — so
     * this specifically exercises the "expected 1-2 commanders" branch, distinct from
     * {@link #rejectsAShortDeck()}'s total-count branch.
     */
    @Test
    void rejectsADeckWithNoCommander() {
        DeckImport d = DeckAssembler.assemble(DeckFormat.MTGO, MtgoLines.parse("100 Forest\n"));
        assertFalse(d.valid());
        assertTrue(d.problems().stream().anyMatch(p -> p.contains("1") && p.contains("commander")),
                () -> String.valueOf(d.problems()));
    }
}
