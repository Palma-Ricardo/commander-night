package night.bridge.lobby.deck;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Blank-line-delimited stanzas, the grammar both Moxfield-produced formats share
 * (deck-import spec §4). A stanza whose first line is a bare {@code HEADER:} is a
 * named extra section — {@code SIDEBOARD:}, {@code PLANES:} — and its header is
 * split out from its cards.
 */
final class Stanzas {

    // Letters and spaces only, deliberately: every known section name (SIDEBOARD:,
    // PLANES:, MAYBEBOARD:) matches, and a card line can never match because card
    // lines always start with a digit. A future header with a digit or an apostrophe
    // would be a false negative here — it would fall through to the card-line parser
    // and be reported as an unparseable line rather than discarded as a section.
    private static final Pattern HEADER = Pattern.compile("^[A-Za-z][A-Za-z ]*:$");

    record Raw(int lineNo, String text) {
    }

    /** {@code header} is null for an unnamed stanza. */
    record Stanza(String header, List<Raw> lines) {
    }

    static List<Stanza> split(String text) {
        List<Stanza> out = new ArrayList<>();
        List<Raw> current = new ArrayList<>();
        int lineNo = 0;
        for (String raw : text.split("\\r?\\n", -1)) {
            lineNo++;
            String line = raw.strip();
            if (line.isEmpty()) {
                flush(out, current);
                current = new ArrayList<>();
                continue;
            }
            current.add(new Raw(lineNo, line));
        }
        flush(out, current);
        return out;
    }

    private static void flush(List<Stanza> out, List<Raw> lines) {
        if (lines.isEmpty()) {
            return;
        }
        String first = lines.get(0).text();
        if (HEADER.matcher(first).matches()) {
            out.add(new Stanza(first, List.copyOf(lines.subList(1, lines.size()))));
        } else {
            out.add(new Stanza(null, List.copyOf(lines)));
        }
    }

    private Stanzas() {
    }
}
