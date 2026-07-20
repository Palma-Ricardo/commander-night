package night.bridge.lobby.deck;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MtgoLinesTest {

    private static List<DeckLine> commanders(ParsedLines p) {
        return p.lines().stream().filter(l -> l.section() == DeckLine.Section.COMMANDER).toList();
    }

    private static int cards(ParsedLines p) {
        return p.lines().stream().mapToInt(DeckLine::qty).sum();
    }

    @Test
    void singleCommanderInTheLastStanza() {
        ParsedLines p = MtgoLines.parse(Fixtures.read("enduring_enchantments.mtgo"));
        assertTrue(p.problems().isEmpty(), () -> String.valueOf(p.problems()));
        assertEquals(100, cards(p));
        assertEquals(List.of("Anikthea, Hand of Erebos"),
                commanders(p).stream().map(DeckLine::name).toList());
        assertNull(p.lines().get(0).setCode(), ".mtgo carries no set code");
    }

    /** The partner pair is structural here: the commander stanza simply has two lines. */
    @Test
    void partnerPairAndDiscardedPlanesSection() {
        ParsedLines p = MtgoLines.parse(Fixtures.read("timey_wimey.mtgo"));
        assertTrue(p.problems().isEmpty(), () -> String.valueOf(p.problems()));
        assertEquals(100, cards(p));
        assertEquals(List.of("Rose Tyler", "The Tenth Doctor"),
                commanders(p).stream().map(DeckLine::name).toList());
        assertEquals(List.of(new ParsedLines.Discarded("PLANES:", 10)), p.discarded());
    }

    /** The section sits between main and commander, not at the end. */
    @Test
    void discardsAMidFileSideboardSection() {
        ParsedLines p = MtgoLines.parse(Fixtures.read("counter_intelligence.mtgo"));
        assertTrue(p.problems().isEmpty(), () -> String.valueOf(p.problems()));
        assertEquals(100, cards(p));
        assertEquals(List.of("Inspirit, Flagship Vessel"),
                commanders(p).stream().map(DeckLine::name).toList());
        assertEquals(List.of(new ParsedLines.Discarded("SIDEBOARD:", 25)), p.discarded());
    }

    @Test
    void repeatedNamesAreKeptAsSeparateLines() {
        // Moxfield emits "4 Forest" twice for two printings; merging would lose a line
        ParsedLines p = MtgoLines.parse("4 Forest\n4 Forest\n\n1 Sythis, Harvest's Hand\n");
        assertEquals(2, p.lines().stream().filter(l -> l.name().equals("Forest")).count());
        assertEquals(9, cards(p));
    }

    @Test
    void reportsAMissingCommanderStanza() {
        ParsedLines p = MtgoLines.parse("1 Sol Ring\n1 Command Tower\n");
        assertEquals(1, p.problems().size());
        assertTrue(p.problems().get(0).contains("commander"), p.problems().get(0));
    }

    @Test
    void reportsAnUnparseableLine() {
        ParsedLines p = MtgoLines.parse("1 Sol Ring\nnot a card line\n\n1 Anikthea, Hand of Erebos\n");
        assertEquals(1, p.problems().size());
        assertTrue(p.problems().get(0).contains("line 2"), p.problems().get(0));
    }
}
