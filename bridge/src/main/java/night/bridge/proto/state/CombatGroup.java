package night.bridge.proto.state;

import java.util.List;

/** Protocol §6 {@code CombatGroup}: one attacker group and its blockers. */
public record CombatGroup(
        List<String> attackerIds,
        String defenderId,
        List<String> blockerIds,
        boolean blocked) {
}
