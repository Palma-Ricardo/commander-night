package night.bridge.lobby.deck;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class DeckFormatTest {

    @Test
    void detectsEachFixture() {
        assertEquals(DeckFormat.DCK, DeckFormat.sniff(Fixtures.read("upgrades_unleashed.dck")));
        assertEquals(DeckFormat.MTGO, DeckFormat.sniff(Fixtures.read("timey_wimey.mtgo")));
        assertEquals(DeckFormat.MOXFIELD, DeckFormat.sniff(Fixtures.read("timey_wimey.moxfield")));
        assertEquals(DeckFormat.MTGO, DeckFormat.sniff(Fixtures.read("counter_intelligence.mtgo")));
        assertEquals(DeckFormat.MOXFIELD, DeckFormat.sniff(Fixtures.read("counter_intelligence.moxfield")));
    }

    /** A .dck line also matches the loose .mtgo shape, so precedence must be dck-first. */
    @Test
    void dckBeatsMtgoOnAmbiguousLines() {
        assertEquals(DeckFormat.DCK, DeckFormat.sniff("1 [MKC:145] Agitator Ant\n"));
    }

    /** One malformed line must not flip the verdict — the vote is over all card lines. */
    @Test
    void majorityWinsOverASingleOddLine() {
        assertEquals(DeckFormat.MOXFIELD,
                DeckFormat.sniff("1 Sol Ring (CMM) 410\n1 Command Tower (CMM) 420\n1 Mystery\n"));
    }

    @Test
    void rejectsTextWithNoCardLines() {
        assertThrows(IllegalArgumentException.class, () -> DeckFormat.sniff("hello\nworld\n"));
    }
}
