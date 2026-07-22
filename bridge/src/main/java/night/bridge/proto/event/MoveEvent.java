package night.bridge.proto.event;

/**
 * Protocol §7.1 {@code move} — the workhorse. {@code objectId} is the stable
 * card id (design §3), valid in both {@code from} and {@code to}. A hand→stack
 * cast emits a {@link StackLinkEvent} alongside, since the stack keys by an
 * ephemeral id. {@code cause}/{@code reason} are enrichments from the log and
 * absent when it says nothing.
 */
public record MoveEvent(
        String objectId,
        Zone from,
        Zone to,
        Verb verb,
        Cause cause,
        String reason) implements GameEvent {

    public MoveEvent(String objectId, Zone from, Zone to, Verb verb) {
        this(objectId, from, to, verb, null, null);
    }
}
