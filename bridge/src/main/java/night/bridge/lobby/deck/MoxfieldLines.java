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
        // A Moxfield list is one unnamed block, optionally followed by named sections
        // (which were already split off above). A second *unnamed* stanza is still a
        // problem, but per deck-import spec §4 a discarded card must never vanish
        // without a trace — so, like a named section, its cards are counted and
        // reported rather than simply skipped. It has no header to label it, so the
        // discard entry is anchored to its starting line number instead.
        for (int i = 1; i < body.size(); i++) {
            Stanzas.Stanza extra = body.get(i);
            int startLine = extra.lines().get(0).lineNo();
            problems.add("unexpected blank line at line " + startLine
                    + " — a Moxfield list is one block, optionally followed by named sections");
            discarded.add(new ParsedLines.Discarded("unnamed section at line " + startLine,
                    DeckText.countCards(extra, LINE, problems)));
        }

        // Section is keyed off physical position within stanza 1, not off lines.size()
        // (the count of successfully parsed lines) — otherwise an unparseable line 1
        // would silently promote line 2 to COMMANDER and line 3 to MAYBE_COMMANDER.
        List<Stanzas.Raw> stanza1 = body.get(0).lines();
        for (int i = 0; i < stanza1.size(); i++) {
            Stanzas.Raw raw = stanza1.get(i);
            Matcher m = LINE.matcher(raw.text());
            if (!m.matches()) {
                problems.add("line " + raw.lineNo() + ": cannot parse: "
                        + DeckText.abbreviate(raw.text()));
                continue;
            }
            DeckLine.Section section = switch (i) {
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
