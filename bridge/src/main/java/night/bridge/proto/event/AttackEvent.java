package night.bridge.proto.event;

import java.util.List;

/**
 * Protocol §7.1 {@code attack} — attackers declared against one defender (a
 * player, planeswalker, or battle). Derived from the {@code combat} groups that
 * appear in the state delta at declare-attackers.
 */
public record AttackEvent(List<String> attackerIds, String defenderId) implements GameEvent {
}
