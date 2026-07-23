package night.bridge.proto.event;

/**
 * Protocol §7.1 {@code shuffle} — a player shuffled their library. Log-derived
 * (the library is not enumerated), best-effort: a missing event costs a riffle
 * animation, never correctness (protocol §7.1).
 */
public record ShuffleEvent(String playerId) implements GameEvent {
}
