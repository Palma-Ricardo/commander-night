package night.bridge.game;

import night.bridge.ai.Brain;
import night.bridge.ai.BrainContext;
import night.bridge.proto.Answer;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.state.GameState;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * Drives a bridge-hosted AI seat: on each presented prompt a {@link Brain}
 * decides an answer and submits it through the seat's own {@link SeatPump}, the
 * same entry a browser answer takes — so PromptFsm validation, promptId
 * fencing, and the ≥150 ms XmageAnswers pacing all apply unchanged. Replaces XMage's server-side {@code COMPUTER_MAD}: no
 * alpha-beta simulation, no per-node {@code Game} clones.
 *
 * <p>Threading: {@link #onPrompt} runs on the pump thread but only hands the
 * (immutable) snapshot to this driver's own single decision thread; the brain's
 * answer re-enters the pump via {@link SeatPump#submitAnswer}, which enqueues
 * onto the pump executor. No brain compute ever runs on the pump thread, and the
 * two hand-offs cannot deadlock. XMage serializes asks per seat, so at most one
 * decision is ever in flight and the per-seat {@link BrainContext} needs no lock.
 */
public final class AiSeatDriver implements SeatDriver {

    private static final Logger log = LoggerFactory.getLogger(AiSeatDriver.class);

    private final Brain brain;
    private final SeatPump pump;
    private final BrainContext ctx = new BrainContext();
    private final ExecutorService think;

    public AiSeatDriver(String label, Brain brain, SeatPump pump) {
        this.brain = brain;
        this.pump = pump;
        this.think = Executors.newSingleThreadExecutor(
                Thread.ofVirtual().name("brain-" + label).factory());
    }

    @Override
    public void onPrompt(GamePrompt prompt, GameState state) {
        long promptId = prompt.promptId();
        try {
            think.execute(() -> {
                try {
                    Answer answer = brain.decide(state, prompt, ctx);
                    pump.submitAnswer(promptId, answer);
                } catch (RuntimeException e) {
                    // BudgetedBrain already falls back to first-legal on a brain bug, so
                    // this is the fallback itself failing. The prompt stays pending and
                    // the seat stalls, visibly: nothing makes XMage re-ask.
                    log.error("brain and fallback failed on prompt {} ({}) — seat stalls",
                            promptId, prompt.kind(), e);
                }
            });
        } catch (RejectedExecutionException e) {
            // driver closed (seat torn down) — nothing left to decide
        }
    }

    @Override
    public void close() {
        think.close();
    }
}
