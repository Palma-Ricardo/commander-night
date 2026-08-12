package night.bridge.game;

import night.bridge.proto.GamePrompt;
import night.bridge.proto.state.GameState;

/**
 * Where a seat's prompts are decided. A browser seat uses {@link #NONE}: its
 * prompt goes out over the WebSocket and the answer returns asynchronously as a
 * {@code game.answer} command. A bridge-hosted AI seat uses {@link AiSeatDriver},
 * which answers the prompt in-JVM through the same {@link SeatPump#answer} path —
 * so all PromptFsm validation, promptId fencing, XmageAnswers pacing, and the
 * nudge watchdog apply unchanged (the AI is just another answer <em>source</em>).
 *
 * <p>{@link #onPrompt} is invoked on the seat pump thread the instant a prompt is
 * presented. Both arguments are deep-immutable snapshots (records + immutable
 * lists), so an implementation may hand them to another thread without violating
 * the pump's single-owner rule (design §4).
 */
public interface SeatDriver {

    void onPrompt(GamePrompt prompt, GameState state);

    default void close() {
    }

    /** Browser seats: the browser answers over the wire; nothing to decide in-JVM. */
    SeatDriver NONE = (prompt, state) -> {
    };
}
