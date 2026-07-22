package night.bridge.golden;

import mage.interfaces.callback.ClientCallback;
import mage.view.AbilityPickerView;
import mage.view.ChatMessage;
import mage.view.GameClientMessage;
import mage.view.GameView;
import mage.view.TableClientMessage;
import night.bridge.proto.LogEntry;
import night.bridge.proto.event.GameEvent;
import night.bridge.proto.event.MoveEvent;
import night.bridge.proto.event.Zone;
import night.bridge.proto.state.Card;
import night.bridge.proto.state.CommandObject;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.Permanent;
import night.bridge.proto.state.Player;
import night.bridge.translate.EventDeriver;
import night.bridge.translate.LogTranslator;
import night.bridge.translate.ViewTranslator;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assumptions.assumeFalse;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * M6 exit criterion (design §5/§12): replay every full-game callback capture
 * offline and assert that <em>every zone transition observable in the state
 * delta is explained by at least one emitted {@link MoveEvent}</em>, printing
 * any residue. No server, no renderer — just the real translate path
 * ({@link ViewTranslator} → {@link LogTranslator} → {@link EventDeriver}) driven
 * from the {@link night.bridge.xmage.CallbackTap} {@code .ser} streams under
 * {@code bridge/logs/tap/}.
 *
 * <p>Captures are Java-serialized ({@link GoldenFixtures#readTap}) rather than
 * the spike's Gson JSONL: the {@code GameView} graph is polymorphic and does not
 * round-trip through Gson — the same limitation that moved the golden tier to
 * Java serialization (design §13). The {@code .ser} files are byte-faithful and
 * replay through the exact translators production uses.
 *
 * <p>The coverage check reimplements the zone map <em>independently</em> of
 * {@code EventDeriver.locMap} on purpose: an assertion that shared the code it
 * verifies could not catch a bug in it. Tagged {@code live} so it stays out of
 * the fast unit tier (it reads hundreds of MB); it needs no server, so run it
 * directly with {@code mvn -Plive test -Dtest=EventCoverageReplayTest}. It skips
 * cleanly when no captures are present.
 */
@Tag("live")
class EventCoverageReplayTest {

    private static final Path TAP = Path.of("logs", "tap");

    @Test
    void everyZoneTransitionIsExplainedByAnEvent() throws Exception {
        assumeTrue(Files.isDirectory(TAP), "no tap captures at " + TAP.toAbsolutePath());
        List<Path> captures;
        try (var s = Files.list(TAP)) {
            captures = s.filter(p -> p.toString().endsWith(".ser"))
                    .filter(p -> uncorrupt(p))
                    .sorted()
                    .toList();
        }
        assumeFalse(captures.isEmpty(), "no .ser captures under " + TAP.toAbsolutePath());

        int totalResidue = 0;
        long totalTransitions = 0;
        for (Path ser : captures) {
            Replay r = new Replay();
            GoldenFixtures.readTap(ser, r::onCallback);
            System.out.printf("%-42s snapshots=%5d transitions=%7d moves=%7d residue=%d%n",
                    ser.getFileName(), r.snapshots, r.transitions, r.moves, r.residue.size());
            r.residue.stream().limit(15).forEach(x -> System.out.println("    unexplained: " + x));
            totalResidue += r.residue.size();
            totalTransitions += r.transitions;
        }
        System.out.printf("== %d captures, %d transitions checked, %d unexplained ==%n",
                captures.size(), totalTransitions, totalResidue);
        assertEquals(0, totalResidue,
                "some state-delta zone transitions had no explaining event (see stdout)");
    }

    private static boolean uncorrupt(Path ser) {
        try {
            return Files.size(ser) > 0;
        } catch (Exception e) {
            return false;
        }
    }

    /** Mirrors the state-bearing slice of {@code SeatPump.handle}, keeping only prev/next. */
    private static final class Replay {
        private UUID myPlayerId;
        private GameState prev;
        private final List<LogEntry> pending = new ArrayList<>();
        int snapshots;
        long transitions;
        long moves;
        final List<String> residue = new ArrayList<>();

        void onCallback(ClientCallback cb) {
            cb.decompressData();
            Object data = cb.getData();
            switch (cb.getMethod()) {
                case START_GAME -> myPlayerId = ((TableClientMessage) data).getPlayerId();
                case GAME_INIT -> {
                    if (data instanceof GameView v) {
                        step(v);
                    }
                }
                case GAME_UPDATE -> step((GameView) data);
                case GAME_UPDATE_AND_INFORM, GAME_INFORM_PERSONAL, GAME_ASK, GAME_SELECT,
                     GAME_TARGET, GAME_PLAY_MANA, GAME_CHOOSE_CHOICE, GAME_CHOOSE_PILE,
                     GAME_GET_AMOUNT, GAME_GET_MULTI_AMOUNT, GAME_PLAY_XMANA, GAME_OVER ->
                        step(((GameClientMessage) data).getGameView());
                case GAME_CHOOSE_ABILITY -> step(((AbilityPickerView) data).getGameView());
                case CHATMESSAGE -> LogTranslator.chat((ChatMessage) data)
                        .ifPresent(line -> pending.add(new LogEntry(0, "g", 0,
                                line.kind(), line.turn(), line.text(), line.refs(), null)));
                default -> {
                }
            }
        }

        private void step(GameView view) {
            if (view == null) {
                return;
            }
            GameState next = ViewTranslator.translate(view, "g", myPlayerId);
            List<GameEvent> events = EventDeriver.derive(prev, next, pending);
            if (!next.equals(prev)) {
                if (prev != null) {
                    checkCoverage(next, events);
                }
                pending.clear();
            }
            prev = next;
        }

        private void checkCoverage(GameState next, List<GameEvent> events) {
            snapshots++;
            List<MoveEvent> ms = new ArrayList<>();
            for (GameEvent e : events) {
                if (e instanceof MoveEvent m) {
                    ms.add(m);
                }
            }
            moves += ms.size();
            Map<String, Zone> before = zones(prev);
            Map<String, Zone> after = zones(next);
            Set<String> ids = new HashSet<>(before.keySet());
            ids.addAll(after.keySet());
            for (String id : ids) {
                Zone from = before.get(id);
                Zone to = after.get(id);
                if (from != null && to != null) {
                    if (from != to) {
                        transitions++;
                        if (!has(ms, id, from, to)) {
                            residue.add(id + " " + from + "->" + to);
                        }
                    }
                } else if (from != null) {          // disappeared to a non-enumerated zone
                    transitions++;
                    if (!hasFrom(ms, id, from)) {
                        residue.add(id + " " + from + "->(unseen)");
                    }
                } else {                            // appeared from a non-enumerated zone
                    transitions++;
                    if (!hasTo(ms, id, to)) {
                        residue.add(id + " (unseen)->" + to);
                    }
                }
            }
        }
    }

    // --- independent zone map + coverage predicates -----------------------------------

    private static Map<String, Zone> zones(GameState s) {
        Map<String, Zone> m = new HashMap<>();
        for (Player p : s.players()) {
            for (Permanent v : p.battlefield()) {
                m.put(v.id(), Zone.BATTLEFIELD);
            }
            for (Card c : p.graveyard()) {
                m.put(c.id(), Zone.GRAVEYARD);
            }
            for (Card c : p.exile()) {
                m.put(c.id(), Zone.EXILE);
            }
            for (CommandObject c : p.commandZone()) {
                m.put(c.id(), Zone.COMMAND);
            }
        }
        if (s.me() != null && s.me().hand() != null) {
            for (Card c : s.me().hand()) {
                m.put(c.id(), Zone.HAND);
            }
        }
        return m;
    }

    private static boolean has(List<MoveEvent> ms, String id, Zone from, Zone to) {
        return ms.stream().anyMatch(m -> m.objectId().equals(id) && m.from() == from && m.to() == to);
    }

    private static boolean hasFrom(List<MoveEvent> ms, String id, Zone from) {
        return ms.stream().anyMatch(m -> m.objectId().equals(id) && m.from() == from);
    }

    private static boolean hasTo(List<MoveEvent> ms, String id, Zone to) {
        return ms.stream().anyMatch(m -> m.objectId().equals(id) && m.to() == to);
    }
}
