package night.bridge.lobby.deck;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Every committed AI-fill deck under {@code bridge/decks/ai} must resolve against
 * the pinned 1.4.60 card database — a deck the server can't build would fail
 * lobby.start at game time. Needs the card DB (the repo {@code db} symlink), not
 * the running XMage server, so it lives in the offline {@code live} tier.
 */
@Tag("live")
class AiDeckLoadLiveTest {

    @Test
    void everyAiDeckResolvesAgainstThePinnedDb() throws IOException {
        Path dir = Path.of("decks", "ai");
        assertTrue(Files.isDirectory(dir), () -> "missing AI deck dir " + dir.toAbsolutePath());
        List<Path> decks;
        try (Stream<Path> files = Files.list(dir)) {
            decks = files.filter(f -> f.getFileName().toString().endsWith(".moxfield")).sorted().toList();
        }
        assertFalse(decks.isEmpty(), () -> "no .moxfield decks in " + dir.toAbsolutePath());
        StringBuilder failures = new StringBuilder();
        for (Path deck : decks) {
            DeckImport parsed = DeckImporter.parse("auto", Files.readString(deck));
            if (!parsed.valid()) {
                failures.append('\n').append(deck.getFileName()).append(": ").append(parsed.problems());
            }
        }
        assertTrue(failures.isEmpty(), () -> "AI decks did not resolve:" + failures);
    }
}
