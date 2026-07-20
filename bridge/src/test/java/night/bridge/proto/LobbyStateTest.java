package night.bridge.proto;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * The null-vs-empty boundary (protocol §5): the deck-import pipeline speaks in empty
 * lists, the wire says "absent means empty". {@link LobbyState.DeckInfo} is where the
 * two meet, so it normalizes empty → null itself rather than trusting every caller to
 * remember — a producer handing it {@code List.of()} and one handing it {@code null}
 * must be indistinguishable on the wire.
 */
class LobbyStateTest {

    private static LobbyState.DeckInfo info(List<String> commander, List<String> problems,
                                            List<String> warnings) {
        return new LobbyState.DeckInfo(true, commander, 100, "moxfield", problems, warnings);
    }

    @Test
    void emptyListsBecomeNullSoTheyAreOmittedFromTheWire() {
        LobbyState.DeckInfo d = info(List.of(), List.of(), List.of());
        assertNull(d.commander());
        assertNull(d.problems());
        assertNull(d.warnings());
    }

    @Test
    void nullAndEmptyProduceIdenticalFrames() throws Exception {
        assertEquals(Json.MAPPER.writeValueAsString(info(null, null, null)),
                Json.MAPPER.writeValueAsString(info(List.of(), List.of(), List.of())));
    }

    @Test
    void populatedListsSurviveNormalization() {
        LobbyState.DeckInfo d = info(List.of("Rose Tyler", "The Tenth Doctor"),
                List.of(), List.of("ignored 10 cards in section PLANES:"));
        assertEquals(List.of("Rose Tyler", "The Tenth Doctor"), d.commander());
        assertNull(d.problems());
        assertEquals(List.of("ignored 10 cards in section PLANES:"), d.warnings());
    }

    @Test
    void listsAreDefensivelyCopied() {
        List<String> mutable = new ArrayList<>(List.of("Rose Tyler"));
        LobbyState.DeckInfo d = info(mutable, List.of(), List.of());
        mutable.add("The Tenth Doctor");
        assertEquals(List.of("Rose Tyler"), d.commander());
        assertThrows(UnsupportedOperationException.class, () -> d.commander().add("Nope"));
    }
}
