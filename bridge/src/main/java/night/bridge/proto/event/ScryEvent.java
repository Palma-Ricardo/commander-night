package night.bridge.proto.event;

/**
 * Protocol §7.1 {@code scry} — a player scried the top of their library.
 * Log-derived, best-effort (protocol §7.1).
 */
public record ScryEvent(String playerId) implements GameEvent {
}
