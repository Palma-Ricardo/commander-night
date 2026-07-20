package night.bridge.lobby.deck;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

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
        assertTrue(p.discarded().isEmpty(), () -> String.valueOf(p.discarded()));
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
        // Guards against dropping the "body.size() > 1 &&" clause from the commander
        // check, which would mislabel the last card of this single stanza COMMANDER.
        assertTrue(p.lines().stream().noneMatch(l -> l.section() == DeckLine.Section.COMMANDER),
                () -> String.valueOf(p.lines()));
    }

    @Test
    void reportsAnUnparseableLine() {
        ParsedLines p = MtgoLines.parse("1 Sol Ring\nnot a card line\n\n1 Anikthea, Hand of Erebos\n");
        assertEquals(1, p.problems().size());
        assertTrue(p.problems().get(0).contains("line 2"), p.problems().get(0));
    }

    /**
     * Three unnamed stanzas: deck, a stray middle stanza, then the commander. The
     * middle stanza is neither a named section (no header) nor the last stanza, so
     * it trips the {@code body.size() > 2 && i > 0 && i < last} guard. Its cards
     * still count as {@link DeckLine.Section#MAIN} — only the last stanza is the
     * commander.
     *
     * <p>Line numbers, counting every physical line including blanks:
     * <pre>
     * 1: 1 Sol Ring
     * 2: 1 Command Tower
     * 3: (blank)
     * 4: 1 Llanowar Elves
     * 5: 1 Birds of Paradise
     * 6: (blank)
     * 7: 1 Anikthea, Hand of Erebos
     * </pre>
     */
    @Test
    void reportsAnUnexpectedExtraSection() {
        ParsedLines p = MtgoLines.parse("1 Sol Ring\n1 Command Tower\n\n"
                + "1 Llanowar Elves\n1 Birds of Paradise\n\n"
                + "1 Anikthea, Hand of Erebos\n");

        assertEquals(1, p.problems().size());
        assertEquals("unexpected extra section at line 4 — an MTGO list should be deck, "
                + "then optional named sections, then the commander", p.problems().get(0));

        Map<String, DeckLine.Section> sectionByName = p.lines().stream()
                .collect(Collectors.toMap(DeckLine::name, DeckLine::section));
        assertEquals(DeckLine.Section.MAIN, sectionByName.get("Sol Ring"));
        assertEquals(DeckLine.Section.MAIN, sectionByName.get("Command Tower"));
        assertEquals(DeckLine.Section.MAIN, sectionByName.get("Llanowar Elves"));
        assertEquals(DeckLine.Section.MAIN, sectionByName.get("Birds of Paradise"));
        assertEquals(DeckLine.Section.COMMANDER, sectionByName.get("Anikthea, Hand of Erebos"));
        assertEquals(List.of("Anikthea, Hand of Erebos"),
                commanders(p).stream().map(DeckLine::name).toList());
    }

    /**
     * A malformed line inside a discarded named section is reported and excluded
     * from that section's card count.
     *
     * <p>Line numbers:
     * <pre>
     * 1: 1 Sol Ring
     * 2: (blank)
     * 3: SIDEBOARD:
     * 4: 2 Brainstorm
     * 5: not a card
     * 6: 3 Ponder
     * 7: (blank)
     * 8: 1 Atraxa, Praetors' Voice
     * </pre>
     */
    @Test
    void reportsAMalformedLineInsideADiscardedSection() {
        ParsedLines p = MtgoLines.parse("1 Sol Ring\n\nSIDEBOARD:\n2 Brainstorm\nnot a card\n3 Ponder\n\n"
                + "1 Atraxa, Praetors' Voice\n");

        assertEquals(1, p.problems().size());
        assertEquals("line 5: cannot parse: not a card", p.problems().get(0));
        assertEquals(List.of(new ParsedLines.Discarded("SIDEBOARD:", 5)), p.discarded());
    }
}
