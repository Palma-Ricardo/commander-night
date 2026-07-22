package night.bridge.proto.event;

/**
 * Protocol §7.1 {@code stackLink} — binds an ephemeral stack id to the stable
 * card/source it came from (design §3), so the client can carry one actor from
 * the hand fan onto the stack and back to the battlefield. Accompanies a
 * hand→stack cast {@link MoveEvent}; for an activated/triggered ability the
 * source is the stable {@code StackItem.card} id and no card moves.
 */
public record StackLinkEvent(
        String stackId,
        String objectId) implements GameEvent {
}
