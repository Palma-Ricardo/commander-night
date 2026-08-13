package night.bridge.ai;

import night.bridge.proto.Answer;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.state.GameState;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link BudgetedBrain} caps a single decision: it returns the primary's answer when
 * it finishes in time, and the fallback's answer (interrupting the primary) when it
 * overruns. A primary exception surfaces unchanged, as if the wrapped brain had been
 * called directly, so the driver's own failure handling is preserved.
 */
class BudgetedBrainTest {

    private static final GamePrompt PROMPT = GamePrompt.confirm(1, "Proceed?", "Yes", "No");
    private final BrainContext ctx = new BrainContext();

    @Test
    void returnsThePrimaryAnswerWhenItFinishesInTime() {
        Brain primary = (state, prompt, c) -> new Answer.Confirm(true);
        Brain fallback = (state, prompt, c) -> new Answer.Confirm(false);
        BudgetedBrain brain = new BudgetedBrain(primary, fallback, Duration.ofSeconds(2));

        assertEquals(new Answer.Confirm(true), brain.decide(null, PROMPT, ctx));
    }

    @Test
    void fallsBackWhenThePrimaryOverrunsTheBudget() {
        Brain slow = (state, prompt, c) -> {
            sleepUninterruptibly(Duration.ofSeconds(5));
            return new Answer.Confirm(true);          // never reached in time
        };
        Answer fallbackAnswer = new Answer.Confirm(false);
        Brain fallback = (state, prompt, c) -> fallbackAnswer;
        BudgetedBrain brain = new BudgetedBrain(slow, fallback, Duration.ofMillis(50));

        long start = System.nanoTime();
        Answer answer = brain.decide(null, PROMPT, ctx);
        long elapsedMs = (System.nanoTime() - start) / 1_000_000;

        assertSame(fallbackAnswer, answer);           // the fallback, not the slow primary
        assertTrue(elapsedMs < 2_000, "should return near the budget, not wait out the primary");
    }

    @Test
    void interruptsThePrimaryWorkerOnTimeout() throws InterruptedException {
        CountDownLatch interrupted = new CountDownLatch(1);
        Brain hangs = (state, prompt, c) -> {
            try {
                Thread.sleep(5_000);
            } catch (InterruptedException e) {
                interrupted.countDown();              // the budget fired and reached us
            }
            return new Answer.Confirm(true);
        };
        BudgetedBrain brain = new BudgetedBrain(hangs, (s, p, c) -> new Answer.Confirm(false),
                Duration.ofMillis(50));

        brain.decide(null, PROMPT, ctx);
        assertTrue(interrupted.await(2, TimeUnit.SECONDS), "worker should be interrupted on timeout");
    }

    @Test
    void primaryExceptionsPropagateUnchanged() {
        IllegalStateException boom = new IllegalStateException("brain bug");
        Brain broken = (state, prompt, c) -> {
            throw boom;
        };
        AtomicBoolean fallbackCalled = new AtomicBoolean(false);
        Brain fallback = (state, prompt, c) -> {
            fallbackCalled.set(true);
            return new Answer.Confirm(false);
        };
        BudgetedBrain brain = new BudgetedBrain(broken, fallback, Duration.ofSeconds(2));

        IllegalStateException thrown =
                assertThrows(IllegalStateException.class, () -> brain.decide(null, PROMPT, ctx));
        assertSame(boom, thrown);                     // same instance, not rewrapped
        assertTrue(!fallbackCalled.get(), "fallback is for timeouts, not for primary failures");
    }

    @Test
    void passesTheRealStateAndContextThroughToTheBrain() {
        GameState marker = new GameState("g", GameState.Status.ACTIVE, true, null,
                java.util.List.of(), java.util.List.of(), null, null, null,
                new GameState.Me("p1", java.util.List.of(), null));
        Brain primary = (state, prompt, c) -> {
            assertSame(marker, state);
            assertSame(ctx, c);
            assertSame(PROMPT, prompt);
            return new Answer.Confirm(true);
        };
        BudgetedBrain brain = new BudgetedBrain(primary, (s, p, c) -> new Answer.Confirm(false),
                Duration.ofSeconds(2));

        Answer answer = brain.decide(marker, PROMPT, ctx);
        assertNotNull(answer);
    }

    private static void sleepUninterruptibly(Duration d) {
        long deadline = System.nanoTime() + d.toNanos();
        long remaining;
        while ((remaining = deadline - System.nanoTime()) > 0) {
            try {
                Thread.sleep(remaining / 1_000_000, (int) (remaining % 1_000_000));
            } catch (InterruptedException e) {
                // swallow — this fake deliberately ignores interruption to exercise the
                // budget's "return the fallback regardless" guarantee.
            }
        }
    }
}
