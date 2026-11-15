package night.bridge.golden;

import mage.interfaces.callback.ClientCallback;
import mage.interfaces.callback.ClientCallbackMethod;
import mage.remote.Session;
import night.bridge.ai.BudgetedBrain;
import night.bridge.ai.FirstLegalMoveBrain;
import night.bridge.ai.HeuristicBrain;
import night.bridge.game.AiSeatDriver;
import night.bridge.game.GameCoordinator;
import night.bridge.game.Games;
import night.bridge.game.SeatPump;
import night.bridge.net.ClientSink;
import night.bridge.xmage.SeatSession;
import night.bridge.xmage.XmageAnswers;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Replays the opening of prod game K32ZYQ (2026-11-15) through a real seat pump and AI
 * driver, against a session that records every positional send. XMage's positional
 * channel pairs sends with asks in order and holds an early send for the seat's next
 * ask (design §5), so any send that isn't the answer to an ask puts the seat one
 * answer ahead for the rest of the game. In K32ZYQ that sent ai1 into a 14,000-lap
 * priority / "Pass anyway?" loop.
 *
 * <p>The fixture is ai1's first 36 callbacks from the prod tap: its mulligan ask (#20),
 * then about six minutes in which XMage asks only the other seats, then its first
 * priority ask (#35). The test asserts one send per ask in order, with the silence
 * held long enough that anything timed would have fired.
 */
class SeatPumpReplayTest {

    private static final Path OPENING = GoldenFixtures.DIR.resolve("replay/k32zyq-ai1-opening.ser");
    /** Longer than any timer the pump could arm after an answer. */
    private static final long SILENCE_MILLIS = 7_000;

    private record Sent(String method, List<Object> args) {
    }

    @Test
    void sendsExactlyOneAnswerPerAskAcrossALongSilence() throws Exception {
        List<ClientCallback> opening = new ArrayList<>();
        GoldenFixtures.readTap(OPENING, opening::add);
        assertEquals(36, opening.size());
        int mulliganAsk = 20;
        int firstPriority = 35;
        assertEquals(ClientCallbackMethod.GAME_ASK, opening.get(mulliganAsk).getMethod());
        assertEquals(ClientCallbackMethod.GAME_SELECT, opening.get(firstPriority).getMethod());

        List<Sent> sent = new CopyOnWriteArrayList<>();
        Session session = (Session) Proxy.newProxyInstance(
                Session.class.getClassLoader(), new Class<?>[]{Session.class},
                (proxy, method, args) -> {
                    if (method.getName().startsWith("sendPlayer") && !method.getName().equals("sendPlayerAction")) {
                        sent.add(new Sent(method.getName(), args == null ? List.of() : Arrays.asList(args)));
                        return true;
                    }
                    Class<?> r = method.getReturnType();
                    return r == boolean.class ? false : r == int.class ? 0 : r == Optional.class ? Optional.empty() : null;
                });

        GameCoordinator coordinator = new GameCoordinator("K32ZYQ", new Games(), null, 60_000);
        SeatPump pump = coordinator.addSeat("u-ai1", "ai1", new SeatSession("cn_K32ZYQ_ai1", session),
                ClientSink.NONE, 200, 50, 100, () -> false);
        pump.driver(new AiSeatDriver("cn_K32ZYQ_ai1", new BudgetedBrain(new HeuristicBrain(),
                new FirstLegalMoveBrain(), BudgetedBrain.DEFAULT_BUDGET), pump));
        try {
            feed(pump, opening.subList(0, mulliganAsk + 1));
            awaitSends(sent, 1);
            assertEquals("sendPlayerBoolean", sent.getFirst().method());
            assertEquals(false, sent.getFirst().args().get(1), "the AI keeps its 7");

            // XMage asks the other seats for minutes; this seat must send nothing meanwhile
            Thread.sleep(SILENCE_MILLIS);
            assertEquals(1, sent.size(), "a send with no ask behind it consumes the next ask: " + sent);

            feed(pump, opening.subList(mulliganAsk + 1, firstPriority + 1));
            awaitSends(sent, 2);
            Thread.sleep(500);
            assertEquals(2, sent.size(), "one answer per ask: " + sent);
            for (Sent s : sent) {
                assertFalse(s.args().contains(XmageAnswers.NUDGE), "no sentinel sends: " + sent);
            }
        } finally {
            pump.close();
        }
    }

    private static void feed(SeatPump pump, List<ClientCallback> callbacks) {
        for (ClientCallback cb : callbacks) {
            cb.decompressData();   // SeatSession decompresses before the pump sees a callback
            pump.onCallback(cb);
        }
    }

    private static void awaitSends(List<Sent> sent, int n) throws InterruptedException {
        long deadline = System.nanoTime() + 5_000_000_000L;
        while (sent.size() < n && System.nanoTime() < deadline) {
            Thread.sleep(20);
        }
        assertTrue(sent.size() >= n, "expected " + n + " sends, got " + sent);
    }
}
