package night.bridge.lobby.deck;

/**
 * Small string helpers shared by the format-specific line parsers
 * ({@link MtgoLines} and its siblings, deck-import spec §4). Kept off any one
 * parser class so the others don't have to reach into a sibling to use it.
 */
final class DeckText {

    static String abbreviate(String line) {
        return line.length() <= 60 ? line : line.substring(0, 57) + "...";
    }

    private DeckText() {
    }
}
