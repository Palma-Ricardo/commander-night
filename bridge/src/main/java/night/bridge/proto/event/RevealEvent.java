package night.bridge.proto.event;

import java.util.List;

/**
 * Protocol §7.1 {@code reveal} — cards shown to the table (a shared reveal
 * window). {@code objectIds} are the revealed card ids; {@code playerId} is the
 * revealer when the log names it (NON_NULL). Derived from a {@code revealed}
 * window appearing in the state delta.
 */
public record RevealEvent(List<String> objectIds, String playerId) implements GameEvent {
}
