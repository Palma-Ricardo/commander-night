package night.bridge.proto;

import java.util.List;

/**
 * Full lobby snapshot on every change (protocol §5) — small enough that no
 * diffing is needed. {@code deck} is null until a seat has submitted one.
 */
public record LobbyState(
        String code,
        String hostUserId,
        List<Seat> seats) implements ServerMsg {

    public record Seat(String userId, String name, DeckInfo deck, boolean ready) {
    }

    public record DeckInfo(
            boolean valid,
            List<String> commander,
            int cards,
            List<String> problems) {
    }
}
