package night.bridge.proto.event;

/**
 * Protocol §7.1 {@code search} — a player searched their library (a tutor). The
 * card that lands is carried by its own {@code move}/{@code hidden}; this event
 * is the library-fan flourish. Log-derived, best-effort (protocol §7.1).
 */
public record SearchEvent(String playerId) implements GameEvent {
}
