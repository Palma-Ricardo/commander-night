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
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Thin per-game aggregate (design §6): the seat list, the gameId → registry
 * binding, and the first-wins game outcome. Everything per-seat lives in the
 * pumps.
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
    private final List<Seat> seats = new ArrayList<>();
    private final AtomicBoolean registered = new AtomicBoolean();
    private final AtomicReference<Outcome> outcome = new AtomicReference<>();

    public GameCoordinator(String lobbyCode, Games games) {
        this.lobbyCode = lobbyCode;
        this.games = games;
    }

    /** Called by the lobby while assembling the game, before startMatch. */
    public SeatPump addSeat(String userId, String displayName, SeatSession xmage,
                            ClientSink sink, int logRingCapacity) {
        SeatPump pump = new SeatPump(xmage.username(), xmage, sink, this, logRingCapacity);
        xmage.sink(pump::onCallback);
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
            games.register(gameId.toString(), this);
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

    public void close(XmageGateway gateway) {
        for (Seat seat : seats) {
            seat.pump().close();
            gateway.release(seat.xmage());
        }
    }
}
