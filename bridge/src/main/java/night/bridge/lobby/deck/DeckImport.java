package night.bridge.lobby.deck;

import mage.cards.decks.DeckCardLists;

import java.util.List;

/**
 * The result of importing a pasted deck (deck-import spec §5). {@code warnings}
 * are non-fatal: a deck carrying them is still {@link #valid()} and startable.
 */
public record DeckImport(DeckFormat format, DeckCardLists deck, List<String> commander,
                         int cards, List<String> problems, List<String> warnings) {

    public DeckImport {
        commander = List.copyOf(commander);
        problems = List.copyOf(problems);
        warnings = List.copyOf(warnings);
    }

    public boolean valid() {
        return problems.isEmpty();
    }
}
