package night.bridge.lobby.deck;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * XMage's native .dck (deck-import spec §4): {@code N [SET:NUM] Name} lines,
 * {@code SB:} marking the sideboard — where Commander decks keep the commander.
 * {@code LAYOUT}/{@code NAME:}/{@code AUTHOR:} metadata lines are skipped; the
 * LAYOUT lines repeat every identity in the deck, so they must not be parsed.
 */
final class DckLines {

    private static final Pattern LINE =
            Pattern.compile("^(SB:\\s*)?(\\d+)\\s+\\[([^:\\]]+):([^\\]]+)]\\s+(.+?)\\s*$");
    private static final Pattern HEADER = Pattern.compile("^(NAME:|AUTHOR:|LAYOUT).*");

    static ParsedLines parse(String text) {
        List<DeckLine> lines = new ArrayList<>();
        List<String> problems = new ArrayList<>();
        int lineNo = 0;
        for (String raw : text.split("\\r?\\n")) {
            lineNo++;
            String line = raw.strip();
            if (line.isEmpty() || HEADER.matcher(line).matches()) {
                continue;
            }
            Matcher m = LINE.matcher(line);
            if (!m.matches()) {
                problems.add("line " + lineNo + ": cannot parse: " + DeckText.abbreviate(line));
                continue;
            }
            lines.add(new DeckLine(
                    Integer.parseInt(m.group(2)), m.group(5).strip(), m.group(3), m.group(4),
                    m.group(1) != null ? DeckLine.Section.COMMANDER : DeckLine.Section.MAIN,
                    lineNo));
        }
        return new ParsedLines(List.copyOf(lines), List.copyOf(problems), List.of());
    }

    private DckLines() {
    }
}
