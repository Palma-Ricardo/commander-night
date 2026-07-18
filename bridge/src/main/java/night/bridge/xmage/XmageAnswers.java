package night.bridge.xmage;

import mage.constants.ManaType;
import mage.constants.PlayerAction;
import mage.remote.Session;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.UUID;
import java.util.function.LongSupplier;

/**
 * Typed wrappers over XMage's positional answer channel (protocol §15 table).
 * Every send is logged — the answers are the half of the conversation the
 * callback tap can't see.
 *
 * <p><b>The lost-wakeup race (1.4.60 {@code HumanPlayer}).</b> The game
 * thread sets {@code responseOpenedForAnswer = true} <em>before</em> entering
 * {@code synchronized (response) { response.wait(); }}, and {@code wait()}
 * has no predicate re-check. Every {@code setResponse*} on the CALL thread
 * first parks in {@code waitResponseOpen()} — a 100 ms spin-poll on that
 * (non-volatile) flag — so an answer that reaches the server while the flag
 * is still closed is delivered <em>on the flag edge</em>, racing the game
 * thread's monitor entry; if its {@code notifyAll} wins the race, the notify
 * is lost and the game thread waits forever (jstack-verified, M3 live tier
 * 2026-07-17). Note the server re-aligns early answers into the window
 * itself, so no arrival-time discipline can fully close the race.
 *
 * <p>Two-part guard: every positional send here waits until
 * ≥{@link #PACE_MILLIS} after the last callback arrived — the human timing
 * profile, which usually lands after the flag is open and the game thread is
 * safely parked — and the {@code SeatPump#armNudge} watchdog covers the rest:
 * a nudge fires only after seconds of ask-silence, when the game thread is
 * guaranteed parked in {@code wait()}, so the nudge's notify cannot be lost.
 */
public final class XmageAnswers {

    private static final Logger log = LoggerFactory.getLogger(XmageAnswers.class);

    /** Minimum gap between the ask's arrival and our answer reaching XMage. */
    static final long PACE_MILLIS = 150;

    /**
     * Never a real object id (XMage mints random v4 UUIDs): every ask kind
     * validates it, rejects it, and re-fires the ask — so it either wakes a
     * lost-notify-wedged game thread or is discarded server-side. Source-
     * verified against 1.4.60 HumanPlayer for all ten prompt kinds.
     */
    public static final UUID NUDGE = new UUID(0, 0);

    private final Session session;
    private final UUID gameId;
    private final UUID playerId;
    private final LongSupplier lastCallbackNanos;

    /** Unpaced variant — unit tests and contexts with no callback clock. */
    public XmageAnswers(Session session, UUID gameId, UUID playerId) {
        this(session, gameId, playerId, null);
    }

    public XmageAnswers(Session session, UUID gameId, UUID playerId, LongSupplier lastCallbackNanos) {
        this.session = session;
        this.gameId = gameId;
        this.playerId = playerId;
        this.lastCallbackNanos = lastCallbackNanos;
    }

    private void pace() {
        if (lastCallbackNanos == null) {
            return;
        }
        long elapsedMillis = (System.nanoTime() - lastCallbackNanos.getAsLong()) / 1_000_000;
        long remaining = PACE_MILLIS - elapsedMillis;
        if (remaining > 0 && remaining <= PACE_MILLIS) {
            try {
                Thread.sleep(remaining);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    public void bool(boolean value) {
        pace();
        log.debug("answer boolean {}", value);
        session.sendPlayerBoolean(gameId, value);
    }

    public void pick(UUID objectId) {
        pace();
        log.debug("answer uuid {}", objectId);
        session.sendPlayerUUID(gameId, objectId);
    }

    public void integer(int value) {
        pace();
        log.debug("answer integer {}", value);
        session.sendPlayerInteger(gameId, value);
    }

    public void text(String value) {
        pace();
        log.debug("answer string {}", value);
        session.sendPlayerString(gameId, value);
    }

    public void mana(ManaType type) {
        pace();
        log.debug("answer mana {}", type);
        session.sendPlayerManaType(gameId, playerId, type);
    }

    /** Out-of-band channel (GameController.executeAction) — no pacing needed. */
    public void action(PlayerAction action) {
        action(action, null);
    }

    /** {@code data} rides ROLLBACK_TURNS (turn count) and permission replies (related user). */
    public void action(PlayerAction action, Object data) {
        log.debug("answer action {} data {}", action, data);
        session.sendPlayerAction(action, gameId, data);
    }

    /** The watchdog's wedge-breaker — see {@link #NUDGE}. Deliberately unpaced. */
    public void nudge() {
        log.warn("nudging XMage's positional channel with the sentinel UUID (lost-wakeup guard)");
        session.sendPlayerUUID(gameId, NUDGE);
    }
}
