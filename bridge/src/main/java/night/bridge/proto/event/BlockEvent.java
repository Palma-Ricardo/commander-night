package night.bridge.proto.event;

import java.util.List;

/**
 * Protocol §7.1 {@code block} — one attacker's declared blockers. Derived from a
 * {@code combat} group that gains blockers in the state delta at declare-blockers.
 */
public record BlockEvent(String attackerId, List<String> blockerIds) implements GameEvent {
}
