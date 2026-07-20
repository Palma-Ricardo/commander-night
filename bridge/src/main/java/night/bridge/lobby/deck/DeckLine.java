package night.bridge.lobby.deck;

/**
 * One card line, format-independent (deck-import spec §4). {@code setCode} and
 * {@code number} are null when the source format does not carry them (.mtgo).
 */
public record DeckLine(int qty, String name, String setCode, String number,
                       Section section, int lineNo) {

    public enum Section {
        MAIN,
        COMMANDER,
        /** .moxfield line 2: a commander only if it partners with line 1 (needs the card db). */
        MAYBE_COMMANDER
    }
}
