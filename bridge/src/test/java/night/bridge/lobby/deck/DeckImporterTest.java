package night.bridge.lobby.deck;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

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

    /**
     * Problem strings are rendered verbatim to a browser (protocol §5), so none of them
     * may be a JVM diagnostic: {@code DeckFormat.valueOf} answers an unknown format with
     * "No enum constant night.bridge.lobby.deck.DeckFormat.CSV", which must never escape.
     */
    @Test
    void badFormatProblemsAreWrittenForAHumanNotForAJvm() {
        for (String requested : new String[]{null, "", "  ", "csv", "moxfeild"}) {
            DeckImport d = DeckImporter.parse(requested, "1 Sol Ring\n");
            String problem = d.problems().getFirst();
            assertFalse(problem.contains("night.bridge"),
                    "leaks an internal class name for format " + requested + ": " + problem);
            assertFalse(problem.contains("enum"),
                    "leaks a JVM diagnostic for format " + requested + ": " + problem);
            assertTrue(problem.contains("auto") && problem.contains("moxfield"),
                    "does not name the accepted formats for " + requested + ": " + problem);
        }
    }
}
