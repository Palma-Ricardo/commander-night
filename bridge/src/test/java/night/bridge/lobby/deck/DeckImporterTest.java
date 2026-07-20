package night.bridge.lobby.deck;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * Fast-tier coverage for {@link DeckImporter}'s input-validation edge cases — none of
 * these reach {@link DeckAssembler}, so none need the card database. The happy paths
 * and the "garbage text" problem-not-exception case live in {@code DeckImporterLiveTest}
 * because they run through {@code DeckAssembler.assemble}, which does.
 */
class DeckImporterTest {

    @Test
    void nullTextIsAProblemNotAnException() {
        DeckImport d = DeckImporter.parse("auto", null);
        assertFalse(d.valid());
        assertEquals(1, d.problems().size());
    }

    @Test
    void nullFormatIsAProblemNotAnException() {
        DeckImport d = DeckImporter.parse(null, "1 Sol Ring\n");
        assertFalse(d.valid());
        assertEquals(1, d.problems().size());
    }

    @Test
    void unrecognisedFormatIsAProblemNotAnException() {
        DeckImport d = DeckImporter.parse("csv", "1 Sol Ring\n");
        assertFalse(d.valid());
        assertEquals(1, d.problems().size());
    }
}
