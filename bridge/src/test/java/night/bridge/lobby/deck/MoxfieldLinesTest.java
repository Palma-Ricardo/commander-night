package night.bridge.lobby.deck;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MoxfieldLinesTest {

    private static int cards(ParsedLines p) {
        return p.lines().stream().mapToInt(DeckLine::qty).sum();
    }

    @Test
    void parsesSetAndCollectorNumber() {
        ParsedLines p = MoxfieldLines.parse(Fixtures.read("enduring_enchantments.moxfield"));
        assertTrue(p.problems().isEmpty(), () -> String.valueOf(p.problems()));
        assertEquals(100, cards(p));
        DeckLine first = p.lines().get(0);
        assertEquals("Anikthea, Hand of Erebos", first.name(), "the *F* foil marker is stripped");
        assertEquals("CMM", first.setCode());
        assertEquals("705", first.number());
        assertEquals(DeckLine.Section.COMMANDER, first.section());
        assertEquals(DeckLine.Section.MAYBE_COMMANDER, p.lines().get(1).section());
        assertEquals(DeckLine.Section.MAIN, p.lines().get(2).section());
    }

    /** PLST/PVOW numbers are not integers; they must survive parsing intact. */
    @Test
    void keepsNonNumericCollectorNumbers() {
        ParsedLines p = MoxfieldLines.parse("1 Sythis, Harvest's Hand (CMM) 938\n"
                + "1 Aura of Silence (PLST) C15-60\n1 Hallowed Haunting (PVOW) 17p\n");
        assertEquals("C15-60", p.lines().get(1).number());
        assertEquals("17p", p.lines().get(2).number());
    }

    @Test
    void discardsNamedSections() {
        ParsedLines p = MoxfieldLines.parse(Fixtures.read("counter_intelligence.moxfield"));
        assertTrue(p.problems().isEmpty(), () -> String.valueOf(p.problems()));
        assertEquals(100, cards(p));
        assertEquals(List.of(new ParsedLines.Discarded("SIDEBOARD:", 25)), p.discarded());
    }

    /** The rule is generic, not a SIDEBOARD:/PLANES: allow-list. */
    @Test
    void discardsAnUnknownSection() {
        ParsedLines p = MoxfieldLines.parse(
                "1 Sol Ring (CMM) 410\n1 Command Tower (CMM) 420\n\nMAYBEBOARD:\n2 Farseek (CMM) 894\n");
        assertEquals(List.of(new ParsedLines.Discarded("MAYBEBOARD:", 2)), p.discarded());
        assertEquals(2, cards(p));
    }

    @Test
    void reportsAnUnparseableLine() {
        ParsedLines p = MoxfieldLines.parse("1 Sol Ring (CMM) 410\nnope\n");
        assertEquals(1, p.problems().size());
        assertTrue(p.problems().get(0).contains("line 2"), p.problems().get(0));
    }

    /**
     * Line 1 fails to parse. Section must be keyed off physical position within
     * stanza 1 (line 2 is position 1, line 3 is position 2), not off the count of
     * successfully parsed lines — otherwise Sol Ring would be silently promoted to
     * COMMANDER and Foo Bar to MAYBE_COMMANDER, though neither occupies that spot.
     */
    @Test
    void anUnparseableFirstLineDoesNotPromoteTheNextLineToCommander() {
        ParsedLines p = MoxfieldLines.parse("nope\n1 Sol Ring (CMM) 410\n1 Foo Bar (CMM) 1\n");

        assertEquals(1, p.problems().size());
        assertTrue(p.problems().get(0).contains("line 1"), p.problems().get(0));
        assertEquals("Sol Ring", p.lines().get(0).name());
        assertEquals(DeckLine.Section.MAYBE_COMMANDER, p.lines().get(0).section());
        assertEquals("Foo Bar", p.lines().get(1).name());
        assertEquals(DeckLine.Section.MAIN, p.lines().get(1).section());
        assertTrue(p.lines().stream().noneMatch(l -> l.section() == DeckLine.Section.COMMANDER),
                () -> String.valueOf(p.lines()));
    }

    /**
     * A second unnamed stanza is still reported as a problem (Moxfield expects one
     * unnamed block plus optional named sections), but per the deck-import spec's
     * "silent dropping is rejected" principle its cards must still be counted and
     * attributed, exactly like a named section's. It has no header to label it, so
     * the discard entry is anchored to its starting line number instead.
     *
     * <p>Line numbers, counting every physical line including blanks:
     * <pre>
     * 1: 1 Sol Ring (CMM) 410
     * 2: 1 Command Tower (CMM) 420
     * 3: (blank)
     * 4: 1 Farseek (CMM) 894
     * </pre>
     */
    @Test
    void foldsAnExtraUnnamedStanzaIntoDiscarded() {
        ParsedLines p = MoxfieldLines.parse(
                "1 Sol Ring (CMM) 410\n1 Command Tower (CMM) 420\n\n1 Farseek (CMM) 894\n");

        assertEquals(1, p.problems().size());
        assertEquals("unexpected blank line at line 4 — a Moxfield list is one block, "
                + "optionally followed by named sections", p.problems().get(0));
        assertEquals(List.of(new ParsedLines.Discarded("unnamed section at line 4", 1)),
                p.discarded());
        assertEquals(2, cards(p));
    }
}
