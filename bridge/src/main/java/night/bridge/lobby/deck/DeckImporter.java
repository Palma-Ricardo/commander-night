package night.bridge.lobby.deck;

import mage.cards.decks.DeckCardLists;

import java.util.List;

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
            format = resolve(requestedFormat, text);
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
     * Resolves a requested format to the syntax to parse with, matching the protocol §5
     * wire names case- and whitespace-insensitively. Every rejection is an
     * {@link IllegalArgumentException} the caller turns into a problem — never an uncaught
     * {@link NullPointerException}, and never {@code Enum.valueOf}'s "No enum constant
     * night.bridge.lobby.deck.DeckFormat.CSV": problem strings are rendered verbatim to a
     * browser, so they are written for the human reading them.
     */
    private static DeckFormat resolve(String requestedFormat, String text) {
        String wanted = requestedFormat == null ? "" : requestedFormat.strip();
        if (wanted.isEmpty()) {
            throw new IllegalArgumentException(
                    "no deck format was specified — expected auto, dck, moxfield or mtgo");
        }
        if (wanted.equalsIgnoreCase("auto")) {
            return DeckFormat.sniff(text);
        }
        for (DeckFormat format : DeckFormat.values()) {
            if (format.wire().equalsIgnoreCase(wanted)) {
                return format;
            }
        }
        throw new IllegalArgumentException("unrecognised deck format \"" + abbreviate(wanted)
                + "\" — expected auto, dck, moxfield or mtgo");
    }

    /** Keeps an echoed-back format request short: it is client-supplied and unbounded. */
    private static String abbreviate(String wanted) {
        return wanted.length() <= 20 ? wanted : wanted.substring(0, 20) + "…";
    }

    private static DeckImport failed(String problem) {
        return new DeckImport(null, new DeckCardLists(), List.of(), 0, List.of(problem), List.of());
    }

    private DeckImporter() {
    }
}
