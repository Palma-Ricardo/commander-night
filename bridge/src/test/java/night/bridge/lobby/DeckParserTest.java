package night.bridge.lobby;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DeckParserTest {

    /** 99 main + commander in SB = a legal Commander list. */
    private static String legalDeck() {
        StringBuilder sb = new StringBuilder();
        sb.append("NAME: test deck\n\n");
        sb.append("35 [KHM:250] Forest\n");
        sb.append("34 [KHM:248] Swamp\n");
        for (int i = 0; i < 30; i++) {
            sb.append("1 [C21:").append(100 + i).append("] Filler Card ").append(i).append('\n');
        }
        sb.append("SB: 1 [KHM:222] Lathril, Blade of the Elves\n");
        return sb.toString();
    }

    @Test
    void legalDeckParses() {
        DeckParser.Parsed p = DeckParser.parseDck(legalDeck());
        assertTrue(p.valid(), () -> String.valueOf(p.info().problems()));
        assertEquals(99, p.deck().getCards().size());
        assertEquals(1, p.deck().getSideboard().size());
        assertEquals(100, p.info().cards());
        assertEquals(List.of("Lathril, Blade of the Elves"), p.info().commander());
        assertNull(p.info().problems());
        // arg order is (name, number, set) — a classic transposition bug
        assertEquals("Lathril, Blade of the Elves", p.deck().getSideboard().getFirst().getCardName());
        assertEquals("222", p.deck().getSideboard().getFirst().getCardNumber());
        assertEquals("KHM", p.deck().getSideboard().getFirst().getSetCode());
    }

    @Test
    void headerAndBlankLinesAreIgnored() {
        DeckParser.Parsed p = DeckParser.parseDck(
                "NAME: x\nAUTHOR: y\nLAYOUT MAIN:(1,1)(NONE,false,50)|([C21:100])\n\n" + legalDeck());
        assertTrue(p.valid(), () -> String.valueOf(p.info().problems()));
    }

    @Test
    void garbageLinesGetPerLineDiagnostics() {
        DeckParser.Parsed p = DeckParser.parseDck("1 Command Tower\n" + legalDeck());
        assertFalse(p.valid());
        assertTrue(p.info().problems().getFirst().contains("line 1"),
                () -> String.valueOf(p.info().problems()));
        // the rest of the deck still parsed — count reflects the 100 good cards
        assertEquals(100, p.info().cards());
    }

    @Test
    void wrongTotalIsAProblem() {
        DeckParser.Parsed p = DeckParser.parseDck(
                "40 [KHM:250] Forest\nSB: 1 [KHM:222] Lathril, Blade of the Elves\n");
        assertFalse(p.valid());
        assertTrue(p.info().problems().getFirst().contains("100"),
                () -> String.valueOf(p.info().problems()));
    }

    @Test
    void missingCommanderIsAProblem() {
        DeckParser.Parsed p = DeckParser.parseDck("100 [KHM:250] Forest\n");
        assertFalse(p.valid());
        assertNull(p.info().commander());
        assertTrue(p.info().problems().stream().anyMatch(s -> s.contains("sideboard")),
                () -> String.valueOf(p.info().problems()));
    }

    @Test
    void partnerCommandersAreBothReported() {
        StringBuilder sb = new StringBuilder("34 [KHM:250] Forest\n34 [KHM:248] Swamp\n30 [KHM:249] Island\n");
        sb.append("SB: 1 [CMR:273] Anara, Wolvid Familiar\n");
        sb.append("SB: 1 [CMR:283] Kodama of the East Tree\n");
        DeckParser.Parsed p = DeckParser.parseDck(sb.toString());
        assertTrue(p.valid(), () -> String.valueOf(p.info().problems()));
        assertEquals(List.of("Anara, Wolvid Familiar", "Kodama of the East Tree"), p.info().commander());
    }
}
