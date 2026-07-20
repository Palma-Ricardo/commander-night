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
    static final Pattern MOX_LINE = Pattern.compile("\\([^)]+\\)\\s+\\S+(?:\\s+\\*\\w+\\*)*$");
    static final Pattern MTGO_LINE = Pattern.compile("^\\d+\\s+\\S");

    private final String wire;

    DeckFormat(String wire) {
        this.wire = wire;
    }

    public String wire() {
        return wire;
    }

    public static DeckFormat sniff(String text) {
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
        return votes.entrySet().stream()
                .max(Map.Entry.comparingByValue())
                .map(Map.Entry::getKey)
                .orElseThrow(() -> new IllegalArgumentException(
                        "cannot tell what deck format this is — expected .dck "
                                + "(1 [SET:NUM] Name), Moxfield (1 Name (SET) NUM) "
                                + "or MTGO (1 Name) lines"));
    }
}
