package night.bridge.ai;

import night.bridge.proto.Answer;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.state.GameState;

/**
 * The in-JVM decision function for a bridge-hosted AI seat: given the current
 * (trimmed, protocol §6) game state and a pending prompt, return the answer to
 * submit. This is the extension point for stronger play — {@link FirstLegalMoveBrain}
 * is the reactive baseline, {@link HeuristicBrain} the first ranked/combat-aware pass.
 *
 * <p>{@code ctx} is per-seat scratch (see {@link BrainContext}) the brain may use
 * to avoid re-trying a dead-end move across a repeating ask (e.g. rotating payMana
 * sources, or casting each object once per land-count level) and to carry richer
 * per-seat plan state. It is touched only on the seat's single decision thread
 * ({@code AiSeatDriver}), so it needs no synchronization.
 */
public interface Brain {

    Answer decide(GameState state, GamePrompt prompt, BrainContext ctx);
}
