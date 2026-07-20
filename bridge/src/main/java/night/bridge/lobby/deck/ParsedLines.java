package night.bridge.lobby.deck;

import java.util.List;

/**
 * A line parser's output. Discarded sections are summarised rather than carried:
 * nothing downstream wants their cards, but the player must be told they were
 * dropped (deck-import spec §4).
 */
public record ParsedLines(List<DeckLine> lines, List<String> problems, List<Discarded> discarded) {

    public ParsedLines {
        lines = List.copyOf(lines);
        problems = List.copyOf(problems);
        discarded = List.copyOf(discarded);
    }

    public record Discarded(String section, int cards) {
    }
}
