package night.bridge.ai;

import night.bridge.proto.Answer;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.GamePrompt.Combat;
import night.bridge.proto.GamePrompt.PlayableAction;
import night.bridge.proto.state.Card;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.Permanent;
import night.bridge.proto.state.Phase;
import night.bridge.proto.state.Player;
import night.bridge.proto.state.Step;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * The first heuristic pass over {@link FirstLegalMoveBrain}: it ranks priority
 * plays by impact and declares attacks by combat math (all other prompt kinds are
 * delegated to the baseline). Tests cover ranked play, the attack model
 * (safe/dying/even-trade/evasion), defensive parsing, and delegation.
 */
class HeuristicBrainTest {

    private static final String ME = "p1";
    private static final String OPP = "p2";

    private final HeuristicBrain brain = new HeuristicBrain();
    private final BrainContext ctx = new BrainContext();

    // ---- ranked play ----

    @Test
    void castsTheBiggerCreature() {
        GameState state = handState(List.of(
                creatureCard("small", 1, 1, 1),
                creatureCard("big", 4, 4, 3)));
        Answer picked = brain.decide(state, GamePrompt.priority(1, "You may play", cast("small", "big")), ctx);
        assertEquals(new Answer.Pick("big"), picked);
    }

    @Test
    void developsLandBeforeCasting() {
        Map<String, List<PlayableAction>> playable = new HashMap<>(cast("big"));
        playable.put("forest", List.of(new PlayableAction(PlayableAction.PLAY, "Play")));
        GameState state = handState(List.of(creatureCard("big", 4, 4, 3)));
        assertEquals(new Answer.Pick("forest"),
                brain.decide(state, GamePrompt.priority(1, "You may play", playable), ctx));
    }

    @Test
    void doesNotRetryTheSameCastAtTheSameLandLevel() {
        GameState state = handState(List.of(creatureCard("big", 4, 4, 3)));
        GamePrompt p = GamePrompt.priority(1, "You may play", cast("big"));
        assertEquals(new Answer.Pick("big"), brain.decide(state, p, ctx));
        assertEquals(new Answer.Confirm(false), brain.decide(state, p, ctx)); // tried → pass
    }

    // ---- attack math ----

    @Test
    void attacksWhenNoBlockersStand() {
        GameState state = combatState(List.of(creature("a1", 3, 3)), List.of());
        assertEquals(new Answer.Pick("a1"), brain.decide(state, attackers(List.of()), ctx));
    }

    @Test
    void holdsBackACreatureThatWouldDieForNothing() {
        // 2/2 into an untapped 3/3: the 3/3 survives (3 > 2) and kills it (3 >= 2).
        GameState state = combatState(List.of(creature("a1", 2, 2)), List.of(creature("b1", 3, 3)));
        assertEquals(new Answer.Confirm(true), brain.decide(state, attackers(List.of()), ctx));
    }

    @Test
    void swingsIntoAnEvenTrade() {
        // 3/3 into an untapped 3/3: the blocker does not survive (3 is not > 3) — attack.
        GameState state = combatState(List.of(creature("a1", 3, 3)), List.of(creature("b1", 3, 3)));
        assertEquals(new Answer.Pick("a1"), brain.decide(state, attackers(List.of()), ctx));
    }

    @Test
    void alwaysSwingsUnblockableEvasion() {
        // 2/2 flyer into an untapped 5/5 ground creature: unblockable → attack anyway.
        GameState state = combatState(
                List.of(creatureWithText("a1", 2, 2, "Flying")),
                List.of(creature("b1", 5, 5)));
        assertEquals(new Answer.Pick("a1"), brain.decide(state, attackers(List.of()), ctx));
    }

    @Test
    void evasionIsBlockedByReach() {
        // Same flyer, but the 5/5 has Reach — it survives and kills, so hold back.
        GameState state = combatState(
                List.of(creatureWithText("a1", 2, 2, "Flying")),
                List.of(creatureWithText("b1", 5, 5, "Reach")));
        assertEquals(new Answer.Confirm(true), brain.decide(state, attackers(List.of()), ctx));
    }

    @Test
    void doesNotSwingAStarPowerCreature() {
        // power "*" parses to 0 — no damage, don't tap it in.
        GameState state = combatState(
                List.of(creatureRaw("a1", "*", "3")), List.of());
        assertEquals(new Answer.Confirm(true), brain.decide(state, attackers(List.of()), ctx));
    }

    // ---- delegation ----

    @Test
    void delegatesNonPriorityKindsToTheBaseline() {
        assertEquals(new Answer.Confirm(false),
                brain.decide(combatState(List.of(), List.of()),
                        GamePrompt.confirm(1, "Mulligan to 6?", "Mulligan", "Keep"), ctx));
    }

    // ---- builders ----

    private static Map<String, List<PlayableAction>> cast(String... ids) {
        Map<String, List<PlayableAction>> m = new HashMap<>();
        for (String id : ids) {
            m.put(id, List.of(new PlayableAction(PlayableAction.CAST, "Cast")));
        }
        return m;
    }

    private static GamePrompt attackers(List<String> declared) {
        return GamePrompt.priority(1, "Declare attackers", Map.of(),
                new Combat(Combat.ATTACKERS, List.of("a1"), declared, null));
    }

    private static GameState handState(List<Card> hand) {
        Player me = player(ME, List.of(), hand.size());
        return new GameState("g", GameState.Status.ACTIVE, true,
                new GameState.Turn(1, Phase.PRECOMBAT_MAIN, Step.PRE_MAIN, ME, ME),
                List.of(me), List.of(), null, null, null,
                new GameState.Me(ME, hand, null));
    }

    private static GameState combatState(List<Permanent> myBoard, List<Permanent> oppBoard) {
        Player me = new Player(ME, ME, true, 40, null, new Player.ManaPool(0, 0, 0, 0, 0, 0),
                90, 0, myBoard, List.of(), List.of(), List.of(), null, null, null, null);
        Player opp = new Player(OPP, OPP, true, 40, null, new Player.ManaPool(0, 0, 0, 0, 0, 0),
                90, 0, oppBoard, List.of(), List.of(), List.of(), null, null, null, null);
        return new GameState("g", GameState.Status.ACTIVE, true,
                new GameState.Turn(1, Phase.COMBAT, Step.DECLARE_ATTACKERS, ME, ME),
                List.of(me, opp), List.of(), null, null, null,
                new GameState.Me(ME, List.of(), null));
    }

    private static Player player(String id, List<Permanent> board, int handSize) {
        return new Player(id, id, true, 40, null, new Player.ManaPool(0, 0, 0, 0, 0, 0),
                90, handSize, board, List.of(), List.of(), List.of(), null, null, null, null);
    }

    private static Card creatureCard(String id, int power, int toughness, int manaValue) {
        return new Card(id, id, "SET", "1", null, manaValue, List.of("CREATURE"), List.of(), List.of(),
                List.of(), List.of(), String.valueOf(power), String.valueOf(toughness),
                null, null, null, null, null, null, null);
    }

    private static Permanent creature(String id, int power, int toughness) {
        return creatureRaw(id, String.valueOf(power), String.valueOf(toughness));
    }

    private static Permanent creatureWithText(String id, int power, int toughness, String... text) {
        return new Permanent(id, id, "SET", "1", null, 0, List.of("CREATURE"), List.of(),
                List.of(), List.of(), List.of(text), String.valueOf(power), String.valueOf(toughness),
                null, null, null, null, null, OPP, false,
                null, null, null, null, null, null, null, null, null);
    }

    private static Permanent creatureRaw(String id, String power, String toughness) {
        return new Permanent(id, id, "SET", "1", null, 0, List.of("CREATURE"), List.of(),
                List.of(), List.of(), List.of(), power, toughness,
                null, null, null, null, null, ME, false,
                null, null, null, null, null, null, null, null, null);
    }
}
