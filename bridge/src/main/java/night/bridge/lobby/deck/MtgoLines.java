package night.bridge.lobby.deck;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * MTGO plain list (deck-import spec §4): {@code N Name} lines, blank-line
 * stanzas, commander in the <b>last unnamed stanza</b>.
 *
 * <p>Note this is deliberately <em>not</em> XMage's {@code TxtDeckImporter} rule,
 * which sends everything after the <em>first</em> blank line to the sideboard and
 * errors on a second one. Real Moxfield MTGO exports interleave a {@code PLANES:}
 * or {@code SIDEBOARD:} section between the deck and the commander, so two of our
 * three fixtures have two blank lines and XMage's own importer mis-handles them.
 */
final class MtgoLines {

    private static final Pattern LINE = Pattern.compile("^(\\d+)\\s+(.+?)\\s*$");

    static ParsedLines parse(String text) {
        List<Stanzas.Stanza> stanzas = Stanzas.split(text);
        List<DeckLine> lines = new ArrayList<>();
        List<String> problems = new ArrayList<>();
        List<ParsedLines.Discarded> discarded = new ArrayList<>();

        List<Stanzas.Stanza> body = new ArrayList<>();
        for (Stanzas.Stanza s : stanzas) {
            if (s.header() != null) {
                discarded.add(new ParsedLines.Discarded(s.header(), countCards(s, problems)));
            } else {
                body.add(s);
            }
        }

        if (body.isEmpty()) {
            problems.add("no cards found");
            return new ParsedLines(List.of(), List.copyOf(problems), List.copyOf(discarded));
        }
        if (body.size() == 1) {
            problems.add("no commander: an MTGO list puts the commander in its own stanza, "
                    + "after a blank line");
        }

        int last = body.size() - 1;
        for (int i = 0; i < body.size(); i++) {
            DeckLine.Section section = (body.size() > 1 && i == last)
                    ? DeckLine.Section.COMMANDER
                    : DeckLine.Section.MAIN;
            if (body.size() > 2 && i > 0 && i < last) {
                problems.add("unexpected extra section at line " + body.get(i).lines().get(0).lineNo()
                        + " — an MTGO list should be deck, then optional named sections, "
                        + "then the commander");
            }
            for (Stanzas.Raw raw : body.get(i).lines()) {
                Matcher m = LINE.matcher(raw.text());
                if (!m.matches()) {
                    problems.add("line " + raw.lineNo() + ": cannot parse: " + DeckText.abbreviate(raw.text()));
                    continue;
                }
                lines.add(new DeckLine(Integer.parseInt(m.group(1)), m.group(2).strip(),
                        null, null, section, raw.lineNo()));
            }
        }
        return new ParsedLines(List.copyOf(lines), List.copyOf(problems), List.copyOf(discarded));
    }

    private static int countCards(Stanzas.Stanza s, List<String> problems) {
        int n = 0;
        for (Stanzas.Raw raw : s.lines()) {
            Matcher m = LINE.matcher(raw.text());
            if (m.matches()) {
                n += Integer.parseInt(m.group(1));
            } else {
                problems.add("line " + raw.lineNo() + ": cannot parse: " + DeckText.abbreviate(raw.text()));
            }
        }
        return n;
    }

    private MtgoLines() {
    }
}
