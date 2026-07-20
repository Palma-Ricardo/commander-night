package night.bridge.lobby.deck;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class StanzasTest {

    @Test
    void splitsOnBlankLinesAndKeepsLineNumbers() {
        List<Stanzas.Stanza> s = Stanzas.split("1 A\n1 B\n\n1 C\n");
        assertEquals(2, s.size());
        assertNull(s.get(0).header());
        assertEquals(2, s.get(0).lines().size());
        assertEquals(1, s.get(0).lines().get(0).lineNo());
        assertEquals("1 C", s.get(1).lines().get(0).text());
        assertEquals(4, s.get(1).lines().get(0).lineNo());
    }

    @Test
    void recognisesAHeaderStanza() {
        List<Stanzas.Stanza> s = Stanzas.split("1 A\n\nPLANES:\n1 Pompeii\n");
        assertEquals(2, s.size());
        assertEquals("PLANES:", s.get(1).header());
        assertEquals(1, s.get(1).lines().size());
        assertEquals("1 Pompeii", s.get(1).lines().get(0).text());
    }

    @Test
    void ignoresRepeatedAndTrailingBlankLines() {
        // trailing blanks are how every sample file ends
        assertEquals(1, Stanzas.split("1 A\n\n\n").size());
        assertEquals(0, Stanzas.split("\n\n").size());
    }
}
