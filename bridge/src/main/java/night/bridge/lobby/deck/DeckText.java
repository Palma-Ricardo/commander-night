package night.bridge.lobby.deck;

import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Small string helpers shared by the format-specific line parsers
 * ({@link MtgoLines} and its siblings, deck-import spec §4). Kept off any one
 * parser class so the others don't have to reach into a sibling to use it.
 */
final class DeckText {

    static String abbreviate(String line) {
        return line.length() <= 60 ? line : line.substring(0, 57) + "...";
    }

    /**
     * Sums the quantities of a discarded stanza's card lines, reporting any line
     * that doesn't match {@code linePattern} as a problem instead of silently
     * dropping it. Shared by every line parser: the quantity is always capture
     * group 1, only the line shape (and therefore {@code linePattern}) differs.
     *
     * <p><b>Contract on {@code linePattern}:</b> capture group 1 must be the card
     * quantity, parseable with {@link Integer#parseInt}. This is a bare convention,
     * not something the compiler or this method can check — both {@code
     * MtgoLines.LINE} and {@code MoxfieldLines.LINE} keep quantity as their first
     * group purely so they can be passed here. If you ever reorder either regex's
     * capture groups, keep (or restore) the quantity in group 1, or this method
     * will parse the wrong group and corrupt discarded-card counts silently rather
     * than fail to compile.
     */
    static int countCards(Stanzas.Stanza s, Pattern linePattern, List<String> problems) {
        int n = 0;
        for (Stanzas.Raw raw : s.lines()) {
            Matcher m = linePattern.matcher(raw.text());
            if (m.matches()) {
                n += Integer.parseInt(m.group(1));
            } else {
                problems.add("line " + raw.lineNo() + ": cannot parse: " + abbreviate(raw.text()));
            }
        }
        return n;
    }

    private DeckText() {
    }
}
