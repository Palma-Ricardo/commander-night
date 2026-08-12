package night.bridge.ai;

import night.bridge.proto.Answer;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.state.GameState;

import java.util.Map;

/**
 * The in-JVM decision function for a bridge-hosted AI seat: given the current
 * (trimmed, protocol §6) game state and a pending prompt, return the answer to
 * submit. This is the extension point for stronger play — v1 is
 * {@link FirstLegalMoveBrain}, a rule-based first-legal-move player.
 *
 * <p>{@code memo} is per-seat scratch the brain may use to avoid re-trying a
 * dead-end move across a repeating ask (e.g. rotating payMana sources, or
 * casting each object once per land-count level). It is touched only on the
 * seat's single decision thread ({@link AiSeatDriver}), so it needs no
 * synchronization.
 */
public interface Brain {

    Answer decide(GameState state, GamePrompt prompt, Map<String, Integer> memo);
}
