package night.bridge.lobby.deck;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

@Tag("live")
class DeckImporterLiveTest {

    @Test
    void autoDetectsAndEchoesTheFormat() {
        DeckImport d = DeckImporter.parse("auto", Fixtures.read("timey_wimey.mtgo"));
        assertTrue(d.valid(), () -> String.valueOf(d.problems()));
        assertEquals(DeckFormat.MTGO, d.format());
    }

    @Test
    void honoursAnExplicitFormat() {
        DeckImport d = DeckImporter.parse("moxfield", Fixtures.read("timey_wimey.moxfield"));
        assertEquals(DeckFormat.MOXFIELD, d.format());
        assertTrue(d.valid(), () -> String.valueOf(d.problems()));
    }

    @Test
    void unrecognisableTextIsAProblemNotAnException() {
        DeckImport d = DeckImporter.parse("auto", "hello\nworld\n");
        assertFalse(d.valid());
        assertEquals(1, d.problems().size());
    }
}
