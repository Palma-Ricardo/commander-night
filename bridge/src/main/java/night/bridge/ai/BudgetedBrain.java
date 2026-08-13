package night.bridge.ai;

import night.bridge.proto.Answer;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.state.GameState;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicReference;

/**
 * A {@link Brain} decorator that caps how long the wrapped brain may spend on one
 * decision. It runs {@code primary.decide} on a throwaway virtual thread and waits
 * at most {@code budget}; if the budget elapses it interrupts that work and answers
 * with {@code fallback} (the tested first-legal baseline) instead. So a heavier
 * brain that hangs or blows up on a single pathological board can never freeze the
 * seat — it degrades to a reliable legal play for that one decision and gets another
 * shot at the next prompt.
 *
 * <p>Today's brains are O(board-size) static evaluation and never come close to the
 * budget; this is the guard rail the plan deferred ("per-decision time budget + FLMB
 * fallback") so future, heavier policies can be dropped in behind {@link Brain}
 * without any risk of a runaway decision stalling a game.
 *
 * <p><b>Threading.</b> The wrapped brains are pure functions over the immutable
 * snapshot, so this decorator carries all the concurrency. It spawns one daemon
 * virtual thread per decision (cheap) and blocks the caller — the seat's single
 * decision thread ({@code AiSeatDriver}) — in {@link Thread#join(Duration)} until the
 * primary finishes or the budget expires. At most one decision per seat is ever in
 * flight, so the per-seat {@link BrainContext} still needs no lock. One decorator
 * instance is safely shared across seats: it holds no per-decision state, and each
 * seat brings its own {@code ctx}.
 *
 * <p><b>On timeout</b> the primary worker is {@link Thread#interrupt() interrupted}
 * (best effort — a well-behaved brain checks interruption at loop heads) and a
 * fallback answer is returned regardless, so the game always advances. A degenerate
 * brain that both ignores interruption <em>and</em> keeps mutating {@code ctx} past
 * the deadline could race the fallback's own {@code ctx} reads; the worst case is a
 * {@code ConcurrentModificationException} out of the fallback, which the driver
 * treats like any brain failure (leaves the prompt pending, the nudge watchdog
 * re-fires it) — the seat still never wedges.
 */
public final class BudgetedBrain implements Brain {

    private static final Logger log = LoggerFactory.getLogger(BudgetedBrain.class);

    /** Generous default: any sane static evaluation finishes in microseconds. */
    public static final Duration DEFAULT_BUDGET = Duration.ofSeconds(2);

    private final Brain primary;
    private final Brain fallback;
    private final Duration budget;

    public BudgetedBrain(Brain primary, Brain fallback, Duration budget) {
        this.primary = primary;
        this.fallback = fallback;
        this.budget = budget;
    }

    @Override
    public Answer decide(GameState state, GamePrompt prompt, BrainContext ctx) {
        // Answer on success, Throwable on failure — the worker never lets one escape,
        // so the primary's exceptions surface to the caller exactly as a direct throw
        // would (preserving the driver's existing "leave pending, re-fire" self-heal).
        AtomicReference<Object> outcome = new AtomicReference<>();
        Thread worker = Thread.ofVirtual()
                .name("brain-budget-" + prompt.promptId())
                .start(() -> {
                    try {
                        outcome.set(primary.decide(state, prompt, ctx));
                    } catch (Throwable t) {
                        outcome.set(t);
                    }
                });

        boolean finished;
        try {
            finished = worker.join(budget);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            worker.interrupt();
            throw new RuntimeException("interrupted awaiting brain decision", e);
        }

        if (!finished) {
            worker.interrupt();
            log.warn("brain exceeded {} ms on prompt {} ({}) — falling back to first-legal",
                    budget.toMillis(), prompt.promptId(), prompt.kind());
            return fallback.decide(state, prompt, ctx);
        }
        return unwrap(outcome.get());
    }

    /** The worker's result: the {@link Answer} it produced, or its failure re-thrown. */
    private static Answer unwrap(Object result) {
        if (result instanceof Answer answer) {
            return answer;
        }
        if (result instanceof RuntimeException re) {
            throw re;
        }
        if (result instanceof Error err) {
            throw err;
        }
        throw new RuntimeException((Throwable) result);
    }
}
