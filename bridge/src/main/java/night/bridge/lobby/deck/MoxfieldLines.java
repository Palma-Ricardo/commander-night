package night.bridge.lobby.deck;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Moxfield native export (deck-import spec §4): {@code N Name (SET) NUM *F*}.
 *
 * <p>Commanders are folded into the head of stanza 1, unmarked — a partner pair
 * occupies lines 1 and 2, a lone commander only line 1, and nothing in the text
 * distinguishes the two cases (the {@code *F*} foil marker appears on ordinary
 * cards too). Line 2 is therefore {@link DeckLine.Section#MAYBE_COMMANDER} and
 * {@code DeckAssembler} settles it against the card database.
 *
 * <p>Collector numbers are <b>not</b> parsed as integers: {@code (PLST) C15-60}
 * and {@code (PVOW) 17p} are real values from the sample decks.
 */
final class MoxfieldLines {

    private static final Pattern LINE = Pattern.compile(
            "^(\\d+)\\s+(.+?)\\s+\\(([^)]+)\\)\\s+(\\S+?)((?:\\s+\\*\\w+\\*)*)\\s*$");

    static ParsedLines parse(String text) {
        List<Stanzas.Stanza> stanzas = Stanzas.split(text);
        List<DeckLine> lines = new ArrayList<>();
        List<String> problems = new ArrayList<>();
        List<ParsedLines.Discarded> discarded = new ArrayList<>();

        List<Stanzas.Stanza> body = new ArrayList<>();
        for (Stanzas.Stanza s : stanzas) {
            if (s.header() != null) {
                discarded.add(new ParsedLines.Discarded(s.header(), DeckText.countCards(s, LINE, problems)));
            } else {
                body.add(s);
            }
        }

        if (body.isEmpty()) {
            problems.add("no cards found");
            return new ParsedLines(List.of(), List.copyOf(problems), List.copyOf(discarded));
        }
        for (int i = 1; i < body.size(); i++) {
            problems.add("unexpected blank line at line " + body.get(i).lines().get(0).lineNo()
                    + " — a Moxfield list is one block, optionally followed by named sections");
        }

        for (Stanzas.Raw raw : body.get(0).lines()) {
            Matcher m = LINE.matcher(raw.text());
            if (!m.matches()) {
                problems.add("line " + raw.lineNo() + ": cannot parse: "
                        + DeckText.abbreviate(raw.text()));
                continue;
            }
            DeckLine.Section section = switch (lines.size()) {
                case 0 -> DeckLine.Section.COMMANDER;
                case 1 -> DeckLine.Section.MAYBE_COMMANDER;
                default -> DeckLine.Section.MAIN;
            };
            lines.add(new DeckLine(Integer.parseInt(m.group(1)), m.group(2).strip(),
                    m.group(3).strip(), m.group(4).strip(), section, raw.lineNo()));
        }
        return new ParsedLines(List.copyOf(lines), List.copyOf(problems), List.copyOf(discarded));
    }

    private MoxfieldLines() {
    }
}
