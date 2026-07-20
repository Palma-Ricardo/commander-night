package night.bridge.lobby;

import mage.cards.decks.DeckCardLists;
import night.bridge.lobby.deck.DeckFormat;
import night.bridge.lobby.deck.DeckImport;
import night.bridge.lobby.deck.DeckImporter;
import night.bridge.proto.LobbyState;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The {@link DeckImport} → {@link LobbyState.DeckInfo} mapping (protocol §5). None of
 * these reach the assembler, so none need the card database.
 *
 * <p>{@code DeckInfo.format} is a bare {@code String} — the {@code proto} package cannot
 * depend on the lobby package — so nothing at compile time stops a wrong spelling, and the
 * strict codec only catches one in dev/test (production decoding is lenient). These tests
 * are the guard: the value must always be {@link DeckFormat#wire()}, never {@code name()},
 * never {@code toString()}, never an echo of the client's format request.
 */
class LobbyDeckInfoTest {

    /** Exactly the three literals protocol §5 allows in {@code lobby.state}'s deck info. */
    private static final Set<String> WIRE_FORMATS = Set.of("dck", "moxfield", "mtgo");

    @Test
    void everyFormatMapsToItsProtocolWireLiteral() {
        for (DeckFormat format : DeckFormat.values()) {
            LobbyState.DeckInfo info = LobbyService.deckInfo(
                    new DeckImport(format, new DeckCardLists(), List.of("Sol Ring"), 100,
                            List.of(), List.of()));
            assertTrue(WIRE_FORMATS.contains(info.format()),
                    () -> format + " maps to '" + info.format() + "', not a protocol §5 literal");
            assertEquals(format.wire(), info.format());
        }
    }

    /**
     * The early-failure paths in {@link DeckImporter} (unreadable format request,
     * unsniffable text) leave {@code DeckImport.format()} null — protocol §5's
     * "absent only when the text was rejected before a syntax could be established".
     * A naive {@code .wire()} NPEs here and takes the whole lobby command with it.
     */
    @Test
    void aNullFormatMapsToNullNotAnException() {
        LobbyState.DeckInfo info = LobbyService.deckInfo(DeckImporter.parse("csv", "1 Sol Ring\n"));
        assertNull(info.format());
        assertFalse(info.valid());
        assertEquals(0, info.cards());
    }

    /** Empty means absent on the wire (protocol §5) — DeckInfo normalizes, the lobby must not pre-empt it. */
    @Test
    void emptyOptionalArraysBecomeAbsent() {
        LobbyState.DeckInfo info = LobbyService.deckInfo(
                new DeckImport(DeckFormat.DCK, new DeckCardLists(), List.of(), 100,
                        List.of(), List.of()));
        assertNull(info.commander());
        assertNull(info.problems());
        assertNull(info.warnings());
        assertTrue(info.valid());
    }

    @Test
    void populatedFieldsRideThrough() {
        LobbyState.DeckInfo info = LobbyService.deckInfo(
                new DeckImport(DeckFormat.MOXFIELD, new DeckCardLists(),
                        List.of("Rose Tyler", "The Tenth Doctor"), 100,
                        List.of("boom"), List.of("careful")));
        assertEquals(List.of("Rose Tyler", "The Tenth Doctor"), info.commander());
        assertEquals(100, info.cards());
        assertEquals("moxfield", info.format());
        assertEquals(List.of("boom"), info.problems());
        assertEquals(List.of("careful"), info.warnings());
        assertFalse(info.valid());
    }
}
