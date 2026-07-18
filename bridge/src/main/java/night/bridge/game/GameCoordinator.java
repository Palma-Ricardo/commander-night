package night.bridge.game;

import night.bridge.net.ClientSink;
import night.bridge.xmage.SeatSession;
import night.bridge.xmage.XmageGateway;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Thin per-game aggregate (design §6): the seat list, the gameId → registry
 * binding, the first-wins game outcome, and the post-game teardown clock.
 * Everything per-seat lives in the pumps.
 */
public final class GameCoordinator {

    private static final Logger log = LoggerFactory.getLogger(GameCoordinator.class);
    private static final Pattern WINNER = Pattern.compile("Player (.+?) is the winner");

    public record Seat(String userId, String displayName, SeatSession xmage, SeatPump pump) {
    }

    /** {@code winnerName} is parsed from XMage's GAME_OVER text; null when unknown. */
    public record Outcome(String reason, String winnerName) {
    }

    private final String lobbyCode;
    private final Games games;
    private final XmageGateway gateway;
    private final long postGameGraceMillis;
    private final List<Seat> seats = new ArrayList<>();
    private final AtomicBoolean registered = new AtomicBoolean();
    private final AtomicReference<Outcome> outcome = new AtomicReference<>();
    private final AtomicInteger finishedSeats = new AtomicInteger();
    private final AtomicBoolean closed = new AtomicBoolean();
    private volatile String registeredGameId;

    public GameCoordinator(String lobbyCode, Games games, XmageGateway gateway,
                           long postGameGraceMillis) {
        this.lobbyCode = lobbyCode;
        this.games = games;
        this.gateway = gateway;
        this.postGameGraceMillis = postGameGraceMillis;
    }

    /** Called by the lobby while assembling the game, before startMatch. */
    public SeatPump addSeat(String userId, String displayName, SeatSession xmage,
                            ClientSink sink, int logRingCapacity, int backfillSend,
                            int keyframeEvery, java.util.function.BooleanSupplier keyframesOnly) {
        SeatPump pump = new SeatPump(xmage.username(), xmage, sink, this, logRingCapacity,
                backfillSend, keyframeEvery, keyframesOnly);
        xmage.sink(pump::onCallback);
        xmage.onDisconnected(pump::onXmageDisconnected);
        seats.add(new Seat(userId, displayName, xmage, pump));
        return pump;
    }

    public List<Seat> seats() {
        return List.copyOf(seats);
    }

    public SeatPump pumpFor(String userId) {
        for (Seat seat : seats) {
            if (seat.userId().equals(userId)) {
                return seat.pump();
            }
        }
        return null;
    }

    /** First seat to see START_GAME registers the game for command routing. */
    void gameKnown(UUID gameId) {
        if (registered.compareAndSet(false, true)) {
            registeredGameId = gameId.toString();
            games.register(registeredGameId, this);
            log.info("lobby {} is now game {}", lobbyCode, gameId);
        }
    }

    /** GAME_OVER text is authoritative ("Player X is the winner" / "Game is a draw"). */
    void recordGameOver(String message) {
        if (message == null) {
            return;
        }
        Matcher m = WINNER.matcher(message);
        Outcome o = new Outcome(message, m.find() ? m.group(1) : null);
        if (!outcome.compareAndSet(null, o) && outcome.get().winnerName() == null && o.winnerName() != null) {
            outcome.set(o); // upgrade a winner-less END_GAME_INFO outcome
        }
    }

    /** Per-seat phrasing ("You lost the game…") — fallback when GAME_OVER hasn't landed. */
    void recordEndInfo(String gameInfo) {
        if (gameInfo != null) {
            outcome.compareAndSet(null, new Outcome(gameInfo, null));
        }
    }

    Outcome outcome() {
        Outcome o = outcome.get();
        return o != null ? o : new Outcome("Game over", null);
    }

    /** Whether every human seat has emitted its game.over. */
    public boolean over() {
        return !seats.isEmpty() && finishedSeats.get() >= seats.size();
    }

    /**
     * A seat reached end-of-life: game over (pump finish()) or lost for good
     * (recovery exhausted, design §5). When the last seat does, start the
     * post-game grace clock (design §6) — chat and resume stay live until it
     * fires. Counting lost seats too is what keeps a game with an abandoned
     * seat from leaking its XMage sessions and registry entry forever.
     */
    void seatFinished() {
        if (finishedSeats.incrementAndGet() != seats.size()) {
            return;
        }
        log.info("game {} over for all seats — teardown in {}s",
                registeredGameId, postGameGraceMillis / 1000);
        Thread.ofVirtual().name("teardown-" + lobbyCode).start(() -> {
            try {
                Thread.sleep(postGameGraceMillis);
            } catch (InterruptedException e) {
                return;
            }
            close();
        });
    }

    /**
     * Idempotent teardown: forget the game (further commands/resume →
     * UNKNOWN_GAME / RESUME_FAILED), stop the pumps, release XMage sessions.
     * Also the lobby's bail-out path when table setup fails mid-launch.
     */
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        if (registeredGameId != null) {
            games.unregister(registeredGameId);
            log.info("game {} torn down", registeredGameId);
        }
        for (Seat seat : seats) {
            seat.pump().close();
            gateway.release(seat.xmage());
        }
    }
}
