package night.bridge.proto.event;

/**
 * Protocol §7.1 {@code life} — a player's life total moved {@code from → to}. The
 * client tumbles the number and pulses a vignette on a large loss. {@code cause}
 * names the source when the log gives it (NON_NULL).
 */
public record LifeEvent(String playerId, int from, int to, Cause cause) implements GameEvent {

    public LifeEvent(String playerId, int from, int to) {
        this(playerId, from, to, null);
    }
}
