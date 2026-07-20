package night.bridge.lobby.deck;

import mage.cards.decks.DeckCardInfo;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

@Tag("live")
class DeckAssemblerLiveTest {

    /**
     * The sniff-then-switch-then-assemble sequence this once duplicated is now
     * {@link DeckImporter#parse}'s job; delegating keeps the two from drifting apart.
     */
    private static DeckImport importOf(String fixture) {
        return DeckImporter.parse("auto", Fixtures.read(fixture));
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

    /** The only end-to-end .dck coverage: 99 maindeck + a single commander in the sideboard slot. */
    @Test
    void importsADckFile() {
        DeckImport d = importOf("upgrades_unleashed.dck");
        assertTrue(d.valid(), () -> String.valueOf(d.problems()));
        assertEquals(List.of("Chishiro, the Shattered Blade"), d.commander());
        assertEquals(99, d.deck().getCards().size());
        assertEquals(1, d.deck().getSideboard().size());
    }

    @Test
    void discardedSectionBecomesAWarningNotAProblem() {
        DeckImport d = importOf("counter_intelligence.moxfield");
        assertTrue(d.valid(), () -> String.valueOf(d.problems()));
        assertEquals(1, d.warnings().stream().filter(w -> w.contains("SIDEBOARD:")).count(),
                () -> String.valueOf(d.warnings()));
        // Substantive text, not just "25": that digit alone could also be satisfied by an
        // unrelated printing-fallback warning (counter_intelligence emits some of those too).
        assertTrue(d.warnings().stream().anyMatch(w -> w.contains("ignored 25 cards")),
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
            assertEveryEntryResolvesBySetAndNumber(mtgo, deck + ".mtgo");
            assertEveryEntryResolvesBySetAndNumber(mox, deck + ".moxfield");
        }
    }

    private static List<String> names(DeckImport d) {
        return d.deck().getCards().stream().map(c -> c.getCardName()).sorted().toList();
    }

    /**
     * Pins the {@link DeckCardInfo} constructor's argument order: {@code (cardName,
     * cardNumber, setCode)} — number before set. Nothing else in this suite would notice a
     * transposition, since every other assertion here reads only {@code getCardName()} and
     * list sizes, both unaffected by which slot holds the set code and which holds the
     * number. But {@code Deck.load} → {@code createCard} looks up printings by
     * {@code CardRepository.findCard(setCode, cardNumber)} and ignores {@code cardName}
     * entirely, so a transposed constructor call would build a deck that resolves zero
     * cards at table-join time while looking completely fine here.
     */
    private static void assertEveryEntryResolvesBySetAndNumber(DeckImport d, String label) {
        Stream.concat(d.deck().getCards().stream(), d.deck().getSideboard().stream())
                .forEach(info -> assertNotNull(
                        CardDb.cards().findCard(info.getSetCode(), info.getCardNumber()),
                        () -> label + ": " + info.getCardName() + " (set=" + info.getSetCode()
                                + ", number=" + info.getCardNumber() + ") does not resolve — "
                                + "check DeckCardInfo's (name, number, set) argument order"));
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
        // The assembler's own "expected 1-2 commanders, found <n>" text, not MtgoLines' separate
        // "no commander" problem — asserting the literal the production code emits for this
        // branch, rather than a loose contains("1") that happens to also match it today.
        assertTrue(d.problems().stream().anyMatch(p -> p.contains("found 0")),
                () -> String.valueOf(d.problems()));
    }
}
