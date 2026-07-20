package night.bridge.lobby.deck;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class DeckTextTest {

    @Test
    void leavesA60CharacterLineUnchanged() {
        String line = "a".repeat(60);
        assertEquals(60, line.length());
        assertEquals(line, DeckText.abbreviate(line));
    }

    @Test
    void truncatesA61CharacterLineToExactly60() {
        String line = "a".repeat(61);
        String expected = "a".repeat(57) + "...";
        String abbreviated = DeckText.abbreviate(line);
        assertEquals(60, abbreviated.length());
        assertEquals(expected, abbreviated);
    }

    @Test
    void leavesAShortLineUntouched() {
        assertEquals("not a card", DeckText.abbreviate("not a card"));
    }
}
