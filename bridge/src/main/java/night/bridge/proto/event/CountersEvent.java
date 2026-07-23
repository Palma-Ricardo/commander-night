package night.bridge.proto.event;

/**
 * Protocol §7.1 {@code counters} — a named counter kind on a card moved
 * {@code from → to}. One event per changed kind on a permanent (e.g. +1/+1,
 * loyalty adjustments come through as their own kinds). The client pops or peels
 * a pip.
 */
public record CountersEvent(String objectId, String name, int from, int to) implements GameEvent {
}
