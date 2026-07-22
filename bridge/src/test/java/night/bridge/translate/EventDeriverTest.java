package night.bridge.translate;

import night.bridge.proto.LogEntry;
import night.bridge.proto.event.Cause;
import night.bridge.proto.event.GameEvent;
import night.bridge.proto.event.HiddenEvent;
import night.bridge.proto.event.MoveEvent;
import night.bridge.proto.event.StackLinkEvent;
import night.bridge.proto.event.StepEvent;
import night.bridge.proto.event.Verb;
import night.bridge.proto.event.Zone;
import night.bridge.proto.state.Card;
import night.bridge.proto.state.CommandObject;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.Permanent;
import night.bridge.proto.state.Phase;
import night.bridge.proto.state.Player;
import night.bridge.proto.state.StackItem;
import night.bridge.proto.state.Step;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The M6 log⋈delta join (protocol §7.1). Each case drives {@link EventDeriver}
 * with a hand-built {@code prev}/{@code next} pair and the log lines XMage 1.4.60
 * emits for that transition, asserting the derived events. The log phrasings are
 * the real ones captured from {@code bridge/logs/spike-*.jsonl}.
 */
class EventDeriverTest {

    private static final String ME = "p1";
    private static final String OPP = "p2";

    @Test
    void castFromHandMovesToStackAndLinks() {
        GameState prev = state(main(), List.of(seat(ME, 90, 1)), List.of(), hand(card("X", "Sensei's Top")));
        GameState next = state(main(), List.of(seat(ME, 90, 0)),
                List.of(spell("S1", "Sensei's Top")), hand());

        List<GameEvent> ev = EventDeriver.derive(prev, next, List.of(
                log("Ricardo casts Sensei's Top from hand", ME, ref("X", "Sensei's Top"))));

        assertEquals(List.of(new MoveEvent("X", Zone.HAND, Zone.STACK, Verb.CAST)), moves(ev));
        assertEquals(List.of(new StackLinkEvent("S1", "X")), links(ev));
    }

    @Test
    void spellResolvesFromStackToBattlefield() {
        GameState prev = state(main(), List.of(seat(ME, 90, 0)),
                List.of(spell("S1", "Grave Titan")), hand());
        GameState next = state(main(), List.of(seatBf(ME, perm("X", "Grave Titan", ME))),
                List.of(), hand());

        List<GameEvent> ev = EventDeriver.derive(prev, next, List.of(
                log("Ricardo puts Grave Titan from stack onto the Battlefield", ME, ref("X", "Grave Titan"))));

        assertEquals(List.of(new MoveEvent("X", Zone.STACK, Zone.BATTLEFIELD, Verb.RESOLVE)), moves(ev));
        assertTrue(links(ev).isEmpty());
    }

    @Test
    void landPlayIsHandToBattlefield() {
        GameState prev = state(main(), List.of(seat(ME, 90, 1)), List.of(), hand(card("X", "Bayou")));
        GameState next = state(main(), List.of(seatBf(ME, perm("X", "Bayou", ME))), List.of(), hand());

        List<GameEvent> ev = EventDeriver.derive(prev, next, List.of(
                log("Ricardo puts Bayou from hand onto the Battlefield", ME, ref("X", "Bayou"))));

        assertEquals(List.of(new MoveEvent("X", Zone.HAND, Zone.BATTLEFIELD, Verb.PLAY)), moves(ev));
    }

    @Test
    void destroyCarriesVerbAndCause() {
        GameState prev = state(combat(), List.of(seat(ME, 90, 0), seatBf(OPP, perm("X", "Zurgo", OPP))),
                List.of(), hand());
        GameState next = state(combat(), List.of(seat(ME, 90, 0), seatGy(OPP, card("X", "Zurgo"))),
                List.of(), hand());

        List<GameEvent> ev = EventDeriver.derive(prev, next, List.of(
                log("Zurgo was destroyed by Wear // Tear", null,
                        ref("X", "Zurgo"), ref("Y", "Wear // Tear"))));

        assertEquals(List.of(new MoveEvent("X", Zone.BATTLEFIELD, Zone.GRAVEYARD, Verb.DESTROY,
                new Cause("Y", "Wear // Tear", null), null)), moves(ev));
    }

    @Test
    void sacrificeReadsAsSacrifice() {
        GameState prev = state(main(), List.of(seatBf(ME, perm("X", "Verdant Catacombs", ME))), List.of(), hand());
        GameState next = state(main(), List.of(seatGy(ME, card("X", "Verdant Catacombs"))), List.of(), hand());

        List<GameEvent> ev = EventDeriver.derive(prev, next, List.of(
                log("Ricardo sacrificed Verdant Catacombs", ME, ref("X", "Verdant Catacombs"))));

        assertEquals(List.of(new MoveEvent("X", Zone.BATTLEFIELD, Zone.GRAVEYARD, Verb.SACRIFICE)), moves(ev));
    }

    @Test
    void millAppearsFromLibrary() {
        GameState prev = state(main(), List.of(seat(ME, 90, 0)), List.of(), hand());
        GameState next = state(main(), List.of(seatGy(ME, card("X", "Counterspell"), 89)), List.of(), hand());

        List<GameEvent> ev = EventDeriver.derive(prev, next, List.of(
                log("Ricardo puts Counterspell from library into their graveyard", ME, ref("X", "Counterspell"))));

        assertEquals(List.of(new MoveEvent("X", Zone.LIBRARY, Zone.GRAVEYARD, Verb.MILL)), moves(ev));
    }

    @Test
    void opponentDrawIsHiddenNotAMove() {
        GameState prev = state(draw(OPP), List.of(seat(ME, 90, 3), seat(OPP, 80, 4)), List.of(), hand());
        GameState next = state(draw(OPP), List.of(seat(ME, 90, 3), seat(OPP, 79, 5)), List.of(), hand());

        List<GameEvent> ev = EventDeriver.derive(prev, next, List.of(log("ai_1 draws a card", OPP)));

        assertEquals(List.of(new HiddenEvent(OPP, Zone.LIBRARY, Zone.HAND, 1, Verb.DRAW)), hidden(ev));
        assertTrue(moves(ev).isEmpty());
    }

    @Test
    void multiDrawCountsCards() {
        GameState prev = state(draw(OPP), List.of(seat(ME, 90, 0), seat(OPP, 80, 0)), List.of(), hand());
        GameState next = state(draw(OPP), List.of(seat(ME, 90, 0), seat(OPP, 73, 7)), List.of(), hand());

        List<GameEvent> ev = EventDeriver.derive(prev, next, List.of(log("ai_1 draws seven cards", OPP)));

        assertEquals(List.of(new HiddenEvent(OPP, Zone.LIBRARY, Zone.HAND, 7, Verb.DRAW)), hidden(ev));
    }

    @Test
    void myOwnDrawIsAVisibleMove() {
        GameState prev = state(draw(ME), List.of(seat(ME, 90, 0)), List.of(), hand());
        GameState next = state(draw(ME), List.of(seat(ME, 89, 1)), List.of(), hand(card("X", "Brainstorm")));

        List<GameEvent> ev = EventDeriver.derive(prev, next, List.of(log("Ricardo draws a card", ME)));

        assertEquals(List.of(new MoveEvent("X", Zone.LIBRARY, Zone.HAND, Verb.DRAW)), moves(ev));
        assertTrue(hidden(ev).isEmpty());
    }

    @Test
    void abilityOnStackLinksToSourceCardNoMove() {
        Permanent top = perm("SRC", "Sensei's Top", ME);
        GameState prev = state(main(), List.of(seatBf(ME, top)), List.of(), hand());
        GameState next = state(main(), List.of(seatBf(ME, top)),
                List.of(ability("A1", "SRC", "Sensei's Top")), hand());

        List<GameEvent> ev = EventDeriver.derive(prev, next, List.of());

        assertEquals(List.of(new StackLinkEvent("A1", "SRC")), links(ev));
        assertTrue(moves(ev).isEmpty());
    }

    @Test
    void tokenMaterializesOnBattlefield() {
        GameState prev = state(main(), List.of(seat(ME, 90, 0)), List.of(), hand());
        GameState next = state(main(), List.of(seatBf(ME, token("T", "Zombie", ME))), List.of(), hand());

        List<GameEvent> ev = EventDeriver.derive(prev, next, List.of());

        assertEquals(List.of(new MoveEvent("T", Zone.BATTLEFIELD, Zone.BATTLEFIELD, Verb.TOKEN)), moves(ev));
    }

    @Test
    void stepEmitsOnlyChangedFields() {
        GameState prev = state(main(), List.of(seat(ME, 90, 0)), List.of(), hand());
        GameState next = state(turn(Phase.COMBAT, Step.BEGIN_COMBAT, ME),
                List.of(seat(ME, 90, 0)), List.of(), hand());

        List<GameEvent> ev = EventDeriver.derive(prev, next, List.of());

        assertEquals(List.of(new StepEvent(Phase.COMBAT, Step.BEGIN_COMBAT, null)), steps(ev));
    }

    @Test
    void turnHandoffCarriesActivePlayer() {
        GameState prev = state(turn(Phase.END, Step.CLEANUP, ME), List.of(seat(ME, 90, 0)), List.of(), hand());
        GameState next = state(turn(Phase.END, Step.CLEANUP, OPP), List.of(seat(ME, 90, 0)), List.of(), hand());

        List<GameEvent> ev = EventDeriver.derive(prev, next, List.of());

        assertEquals(List.of(new StepEvent(null, null, OPP)), steps(ev));
    }

    @Test
    void firstSnapshotAndUnchangedStateAreSilent() {
        GameState s = state(main(), List.of(seat(ME, 90, 0)), List.of(), hand());
        assertTrue(EventDeriver.derive(null, s, List.of()).isEmpty());
        assertTrue(EventDeriver.derive(s, s, List.of()).isEmpty());
    }

    // ---- filters ----

    private static List<MoveEvent> moves(List<GameEvent> ev) {
        return ev.stream().filter(MoveEvent.class::isInstance).map(MoveEvent.class::cast).toList();
    }

    private static List<StackLinkEvent> links(List<GameEvent> ev) {
        return ev.stream().filter(StackLinkEvent.class::isInstance).map(StackLinkEvent.class::cast).toList();
    }

    private static List<HiddenEvent> hidden(List<GameEvent> ev) {
        return ev.stream().filter(HiddenEvent.class::isInstance).map(HiddenEvent.class::cast).toList();
    }

    private static List<StepEvent> steps(List<GameEvent> ev) {
        return ev.stream().filter(StepEvent.class::isInstance).map(StepEvent.class::cast).toList();
    }

    // ---- fixture builders (only the fields the deriver reads) ----

    private static GameState state(GameState.Turn turn, List<Player> players,
                                   List<StackItem> stack, GameState.Me me) {
        return new GameState("g", GameState.Status.ACTIVE, false, turn, players, stack,
                null, null, null, me);
    }

    private static GameState.Turn turn(Phase phase, Step step, String active) {
        return new GameState.Turn(3, phase, step, active, active);
    }

    private static GameState.Turn main() {
        return turn(Phase.PRECOMBAT_MAIN, Step.PRE_MAIN, ME);
    }

    private static GameState.Turn combat() {
        return turn(Phase.COMBAT, Step.COMBAT_DAMAGE, ME);
    }

    private static GameState.Turn draw(String active) {
        return turn(Phase.BEGINNING, Step.DRAW, active);
    }

    private static GameState.Me hand(Card... cards) {
        return new GameState.Me(ME, List.of(cards), null);
    }

    private static Player seat(String id, int librarySize, int handSize) {
        return player(id, librarySize, handSize, List.of(), List.of());
    }

    private static Player seatBf(String id, Permanent... bf) {
        return player(id, 90, 0, List.of(bf), List.of());
    }

    private static Player seatGy(String id, Card gy) {
        return player(id, 90, 0, List.of(), List.of(gy));
    }

    private static Player seatGy(String id, Card gy, int librarySize) {
        return player(id, librarySize, 0, List.of(), List.of(gy));
    }

    private static Player player(String id, int librarySize, int handSize,
                                 List<Permanent> bf, List<Card> gy) {
        return new Player(id, id, true, 40, null, new Player.ManaPool(0, 0, 0, 0, 0, 0),
                librarySize, handSize, bf, gy, List.of(), List.of(), null, null, null);
    }

    private static Card card(String id, String name) {
        return new Card(id, name, "SET", "1", null, 0, List.of(), List.of(), List.of(), List.of(),
                List.of(), null, null, null, null, null, null, null, null);
    }

    private static Permanent perm(String id, String name, String controller) {
        return permanent(id, name, controller, null);
    }

    private static Permanent token(String id, String name, String controller) {
        return permanent(id, name, controller, Boolean.TRUE);
    }

    private static Permanent permanent(String id, String name, String controller, Boolean token) {
        return new Permanent(id, name, "SET", "1", null, 0, List.of(), List.of(), List.of(), List.of(),
                List.of(), null, null, null, null, null, token, null,
                controller, false, null, null, null, null, null, null, null, null);
    }

    private static StackItem spell(String ephemeralId, String name) {
        return new StackItem(ephemeralId, null, StackItem.Kind.SPELL, card(ephemeralId, name), List.of(), null);
    }

    private static StackItem ability(String ephemeralId, String sourceId, String name) {
        return new StackItem(ephemeralId, null, StackItem.Kind.ABILITY, card(sourceId, name), List.of(), null);
    }

    @SuppressWarnings("unused")
    private static CommandObject commander(String id, String name) {
        return new CommandObject(id, name, "SET", "1", null, 0, List.of(), List.of(), List.of(),
                List.of(), List.of(), null, null, null, null, null, null, null,
                CommandObject.Kind.COMMANDER, 0);
    }

    private static LogEntry log(String text, String playerId, LogEntry.Ref... refs) {
        return new LogEntry(0, "g", 0, LogEntry.Kind.GAME, null, text,
                refs.length == 0 ? null : List.of(refs), playerId);
    }

    private static LogEntry.Ref ref(String id, String name) {
        return new LogEntry.Ref(id, name);
    }
}
