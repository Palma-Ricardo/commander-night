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
}
