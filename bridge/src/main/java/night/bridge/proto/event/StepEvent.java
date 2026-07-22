package night.bridge.proto.event;

import night.bridge.proto.state.Phase;
import night.bridge.proto.state.Step;

/**
 * Protocol §7.1 {@code step} — the turn structure advanced. A new
 * {@code activePlayerId} is the table client's cue to re-frame the camera on the
 * new active player (design §9). Only the fields that changed are set; the rest
 * are omitted (NON_NULL).
 */
public record StepEvent(
        Phase phase,
        Step step,
        String activePlayerId) implements GameEvent {
}
