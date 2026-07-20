package night.bridge.lobby.deck;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DckLinesTest {

    @Test
    void parsesTheDistSampleDeck() {
        ParsedLines p = DckLines.parse(Fixtures.read("upgrades_unleashed.dck"));
        assertTrue(p.problems().isEmpty(), () -> String.valueOf(p.problems()));
        assertEquals(100, p.lines().stream().mapToInt(DeckLine::qty).sum());
        assertEquals(List.of("Chishiro, the Shattered Blade"),
                p.lines().stream()
                        .filter(l -> l.section() == DeckLine.Section.COMMANDER)
                        .map(DeckLine::name).toList());
    }

    @Test
    void headerAndLayoutLinesAreIgnored() {
        ParsedLines p = DckLines.parse("NAME: x\nAUTHOR: y\nLAYOUT MAIN:(1,1)|([C21:100])\n"
                + "1 [C21:263] Command Tower\nSB: 1 [KHM:222] Lathril, Blade of the Elves\n");
        assertTrue(p.problems().isEmpty(), () -> String.valueOf(p.problems()));
        assertEquals(2, p.lines().size());
    }

    @Test
    void quantityExpandsAndFieldsLandInTheRightSlots() {
        ParsedLines p = DckLines.parse("9 [HOB:198] Swamp\n");
        DeckLine only = p.lines().get(0);
        assertEquals(9, only.qty());
        assertEquals("Swamp", only.name());
        assertEquals("HOB", only.setCode());
        assertEquals("198", only.number());
    }

    @Test
    void reportsAnUnparseableLine() {
        ParsedLines p = DckLines.parse("1 [C21:263] Command Tower\ngarbage\n");
        assertEquals(1, p.problems().size());
        assertTrue(p.problems().get(0).contains("line 2"), p.problems().get(0));
        // the rest of the deck still parsed — the good line before the garbage landed
        assertEquals(1, p.lines().size());
        assertEquals("Command Tower", p.lines().get(0).name());
    }

    @Test
    void blankLinesAreSkipped() {
        ParsedLines p = DckLines.parse("1 [C21:263] Command Tower\n\n2 [KHM:250] Forest\n\n\n"
                + "SB: 1 [KHM:222] Lathril, Blade of the Elves\n");
        assertTrue(p.problems().isEmpty(), () -> String.valueOf(p.problems()));
        assertEquals(3, p.lines().size());
        assertEquals("Command Tower", p.lines().get(0).name());
        assertEquals("Forest", p.lines().get(1).name());
        assertEquals("Lathril, Blade of the Elves", p.lines().get(2).name());
    }

    @Test
    void sideboardMarkerWithIrregularSpacing() {
        ParsedLines pNoSpace = DckLines.parse("SB:1 [KHM:222] Lathril, Blade of the Elves\n");
        assertTrue(pNoSpace.problems().isEmpty(), () -> String.valueOf(pNoSpace.problems()));
        assertEquals(1, pNoSpace.lines().size());
        assertEquals(DeckLine.Section.COMMANDER, pNoSpace.lines().get(0).section());

        ParsedLines pExtraSpace = DckLines.parse("SB:   1 [KHM:222] Lathril, Blade of the Elves\n");
        assertTrue(pExtraSpace.problems().isEmpty(), () -> String.valueOf(pExtraSpace.problems()));
        assertEquals(1, pExtraSpace.lines().size());
        assertEquals(DeckLine.Section.COMMANDER, pExtraSpace.lines().get(0).section());
    }
}
