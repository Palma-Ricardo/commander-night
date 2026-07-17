package night.bridge.proto.state;

import java.util.List;

/** A titled card window: shared reveals or this-seat-only looks (protocol §6). */
public record NamedCards(String name, List<Card> cards) {
}
