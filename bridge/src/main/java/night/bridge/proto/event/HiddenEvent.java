package night.bridge.proto.event;

/**
 * Protocol §7.1 {@code hidden} — anonymous movement of hidden information (an
 * opponent's draw, a face-down tutor). No object id exists on our side, so the
 * client animates {@code count} card backs between {@code from} and {@code to}.
 * Derived from {@code handSize}/{@code librarySize} count deltas that no visible
 * move explains (design §3, §5).
 */
public record HiddenEvent(
        String playerId,
        Zone from,
        Zone to,
        int count,
        Verb verb) implements GameEvent {
}
