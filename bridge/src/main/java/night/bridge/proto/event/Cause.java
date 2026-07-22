package night.bridge.proto.event;

/**
 * Protocol §7.1 {@code Cause}: what caused a move, when the log names it — the
 * {@code (source: …)} / {@code destroyed by …} card, or the acting player. All
 * fields optional; absent ones are omitted from the wire (NON_NULL).
 */
public record Cause(String objectId, String name, String playerId) {
}
