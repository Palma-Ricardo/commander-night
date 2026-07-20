package night.bridge.lobby.deck;

import mage.cards.decks.DeckCardLists;

import java.util.List;
import java.util.Locale;

/**
 * The deck-import entry point (deck-import spec §4). Callers hand over text and a
 * requested format; everything downstream is internal to this package.
 */
public final class DeckImporter {

    /**
     * @param requestedFormat {@code "auto"}, {@code "dck"}, {@code "moxfield"} or {@code "mtgo"}
     * @return never null — an unusable deck comes back with {@code problems}, not an exception
     */
    public static DeckImport parse(String requestedFormat, String text) {
        if (text == null) {
            return failed("no deck text was submitted");
        }
        DeckFormat format;
        try {
            format = "auto".equalsIgnoreCase(requestedFormat)
                    ? DeckFormat.sniff(text)
                    : DeckFormat.valueOf(requireFormat(requestedFormat));
        } catch (IllegalArgumentException e) {
            return failed(e.getMessage());
        }
        ParsedLines lines = switch (format) {
            case DCK -> DckLines.parse(text);
            case MTGO -> MtgoLines.parse(text);
            case MOXFIELD -> MoxfieldLines.parse(text);
        };
        return DeckAssembler.assemble(format, lines);
    }

    /**
     * Upper-cases a non-{@code "auto"} format request, rejecting {@code null} the same
     * way an unrecognised format string is rejected — as an {@link IllegalArgumentException}
     * the caller converts to a problem, never as an uncaught {@link NullPointerException}.
     */
    private static String requireFormat(String requestedFormat) {
        if (requestedFormat == null) {
            throw new IllegalArgumentException(
                    "no deck format was specified — expected auto, dck, moxfield or mtgo");
        }
        return requestedFormat.toUpperCase(Locale.ROOT);
    }

    private static DeckImport failed(String problem) {
        return new DeckImport(null, new DeckCardLists(), List.of(), 0, List.of(problem), List.of());
    }

    private DeckImporter() {
    }
}
