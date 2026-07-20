package night.bridge.lobby.deck;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;

/**
 * Sample decks under src/test/resources/decks (deck-import spec §8). Public so the
 * live tier in {@code night.bridge.live} can paste them too.
 */
public final class Fixtures {

    public static String read(String name) {
        try (InputStream in = Fixtures.class.getResourceAsStream("/decks/" + name)) {
            if (in == null) {
                throw new IllegalArgumentException("no such deck fixture: " + name);
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private Fixtures() {
    }
}
