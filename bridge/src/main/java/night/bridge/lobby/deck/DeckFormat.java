package night.bridge.lobby.deck;

import java.util.EnumMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Which of the three syntaxes a pasted deck is (deck-import spec §4). The shapes
 * are mutually exclusive per line: .dck puts [SET:NUM] <em>before</em> the name,
 * .moxfield puts (SET) NUM <em>after</em> it, .mtgo has neither.
 *
 * <p>Classification is a majority vote over card-shaped lines rather than
 * first-match, so one malformed line cannot flip the verdict. Precedence is
 * dck → moxfield → mtgo, because the .mtgo shape ("qty then anything") also
 * matches lines of the other two.
 */
public enum DeckFormat {

    DCK("dck"),
    MOXFIELD("moxfield"),
    MTGO("mtgo");

    static final Pattern DCK_LINE = Pattern.compile("^(?:SB:\\s*)?\\d+\\s+\\[[^:\\]]+:[^\\]]+]");
    // The parenthesised group is deliberately narrow (\w+, "looks like a set code" —
    // spec §4) rather than [^)]+ ("anything but a closing paren"). A wider group plus
    // .find() + $ means a hand-typed .mtgo aside like "1 Sol Ring (need one more) x2"
    // gets misread as Moxfield; \w+ rejects multi-word parenthetical asides while still
    // matching every real set code in the fixtures. The awkward collector numbers
    // (C15-60, EMA-26, 17p, ...) live in the trailing \S+ slot, not this group.
    static final Pattern MOX_LINE = Pattern.compile("\\(\\w+\\)\\s+\\S+(?:\\s+\\*\\w+\\*)*$");
    static final Pattern MTGO_LINE = Pattern.compile("^\\d+\\s+\\S");

    private final String wire;

    DeckFormat(String wire) {
        this.wire = wire;
    }

    public String wire() {
        return wire;
    }

    public static DeckFormat sniff(String text) {
        if (text == null) {
            throw new IllegalArgumentException(
                    "cannot tell what deck format this is — text is null");
        }
        Map<DeckFormat, Integer> votes = new EnumMap<>(DeckFormat.class);
        for (String raw : text.split("\\r?\\n")) {
            String line = raw.strip();
            if (line.isEmpty()) {
                continue;
            }
            if (line.startsWith("LAYOUT") || DCK_LINE.matcher(line).find()) {
                votes.merge(DCK, 1, Integer::sum);
            } else if (MOX_LINE.matcher(line).find()) {
                votes.merge(MOXFIELD, 1, Integer::sum);
            } else if (MTGO_LINE.matcher(line).find()) {
                votes.merge(MTGO, 1, Integer::sum);
            }
        }
        // Precedence (dck -> moxfield -> mtgo, per the class javadoc) is delivered
        // explicitly here by iterating the declared enum order and keeping strictly
        // greater counts, rather than relying on EnumMap/Stream.max incidentally
        // preserving ordinal order on a tie.
        DeckFormat winner = null;
        int max = 0;
        for (DeckFormat format : values()) {
            int count = votes.getOrDefault(format, 0);
            if (count > max) {
                max = count;
                winner = format;
            }
        }
        if (winner == null) {
            throw new IllegalArgumentException(
                    "cannot tell what deck format this is — expected .dck "
                            + "(1 [SET:NUM] Name), Moxfield (1 Name (SET) NUM) "
                            + "or MTGO (1 Name) lines");
        }
        return winner;
    }
}
