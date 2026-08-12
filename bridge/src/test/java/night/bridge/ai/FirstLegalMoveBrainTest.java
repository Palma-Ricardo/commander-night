package night.bridge.ai;

import night.bridge.proto.Answer;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.GamePrompt.Among;
import night.bridge.proto.GamePrompt.Combat;
import night.bridge.proto.GamePrompt.Option;
import night.bridge.proto.GamePrompt.PlayableAction;
import night.bridge.proto.GamePrompt.Progress;
import night.bridge.proto.state.Card;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.Permanent;
import night.bridge.proto.state.Phase;
import night.bridge.proto.state.Player;
import night.bridge.proto.state.Step;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * The v1 bridge-AI brain, per prompt kind. Mirrors the live-test auto-player it
 * was ported from ({@code LiveHarness.autoAnswer}) — first-legal-move: keep
 * hands, play lands then creatures then anything castable, attack with every
 * eligible creature, pay by rotating sources, first-option/minimum elsewhere.
 */
class FirstLegalMoveBrainTest {

    private static final String ME = "p1";

    private final FirstLegalMoveBrain brain = new FirstLegalMoveBrain();
    private final Map<String, Integer> memo = new HashMap<>();

    private Answer decide(GamePrompt prompt) {
        return brain.decide(state(0), prompt, memo);
    }

    private Answer decide(GameState state, GamePrompt prompt) {
        return brain.decide(state, prompt, memo);
    }

    @Test
    void keepsEveryHand() {
        assertEquals(new Answer.Confirm(false),
                decide(GamePrompt.confirm(1, "Mulligan to 6?", "Mulligan", "Keep")));
    }

    @Test
    void confirmsFloatingManaAsks() {
        assertEquals(new Answer.Confirm(true),
                decide(GamePrompt.confirm(1, "You have mana in your pool. Pass anyway?", "Yes", "No")));
    }

    @Test
    void escapesAnUnforeseenRepeatingConfirmAfterFive() {
        GamePrompt p = GamePrompt.confirm(1, "Do the thing?", "Yes", "No");
        for (int i = 0; i < 5; i++) {
            assertEquals(new Answer.Confirm(false), decide(p));
        }
        assertEquals(new Answer.Confirm(true), decide(p)); // sixth sighting
    }

    @Test
    void playsALandAtPriority() {
        assertEquals(new Answer.Pick("landCard"),
                decide(GamePrompt.priority(1, "You may play", play("landCard"))));
    }

    @Test
    void prefersCastingACreatureOverOtherSpells() {
        Map<String, List<PlayableAction>> playable = new HashMap<>();
        playable.put("creatureCard", List.of(new PlayableAction(PlayableAction.CAST, "Cast")));
        playable.put("otherCard", List.of(new PlayableAction(PlayableAction.CAST, "Cast")));
        GameState state = state(3, creature("creatureCard"));
        assertEquals(new Answer.Pick("creatureCard"),
                decide(state, GamePrompt.priority(1, "You may play", playable)));
    }

    @Test
    void doesNotRetryTheSameObjectAtTheSameLandLevel() {
        GamePrompt p = GamePrompt.priority(1, "You may play", play("landCard"));
        assertEquals(new Answer.Pick("landCard"), decide(p));
        assertEquals(new Answer.Confirm(false), decide(p)); // already tried at this land level → pass
    }

    @Test
    void passesPriorityWithNothingToDo() {
        assertEquals(new Answer.Confirm(false),
                decide(GamePrompt.priority(1, "You may play", Map.of())));
    }

    @Test
    void attacksWithEveryEligibleCreatureThenConfirmsDone() {
        assertEquals(new Answer.Pick("a1"), decide(attackers(List.of())));
        assertEquals(new Answer.Pick("a2"), decide(attackers(List.of("a1"))));
        assertEquals(new Answer.Confirm(true), decide(attackers(List.of("a1", "a2"))));
    }

    @Test
    void declinesToBlock() {
        GamePrompt p = GamePrompt.priority(1, "Select blockers", Map.of(),
                new Combat(Combat.BLOCKERS, List.of("b1"), List.of(), null));
        assertEquals(new Answer.Confirm(true), decide(p));
    }

    @Test
    void submitsRequiredTargetsWholeSet() {
        GamePrompt p = GamePrompt.chooseTargets(1, "Choose up to 2", List.of("t1", "t2", "t3"),
                1, 2, true, "battlefield", new Progress(0, 2), List.of());
        assertEquals(new Answer.Picks(List.of("t1", "t2")), decide(p));
    }

    @Test
    void cancelsOptionalTargets() {
        GamePrompt p = GamePrompt.chooseTargets(1, "You may choose", List.of("t1"),
                0, 1, false, "battlefield", new Progress(0, 1), List.of());
        assertEquals(new Answer.Cancel(), decide(p));
    }

    @Test
    void confirmsRequiredTargetsWithNothingToPick() {
        GamePrompt p = GamePrompt.chooseTargets(1, "Choose", List.of(),
                0, 1, true, "battlefield", new Progress(0, 1), List.of());
        assertEquals(new Answer.Confirm(true), decide(p));
    }

    @Test
    void rotatesManaSourcesThenCancels() {
        GamePrompt p = GamePrompt.payMana(1, "Pay {2}", "{2}", List.of("s1", "s2"), true);
        assertEquals(new Answer.Pick("s1"), decide(p));
        assertEquals(new Answer.Pick("s2"), decide(p));
        assertEquals(new Answer.Cancel(), decide(p)); // each source tried → give up
    }

    @Test
    void picksTheFirstAbility() {
        GamePrompt p = GamePrompt.chooseAbility(1, "Which ability?",
                List.of(Option.byId("ab1", "First"), Option.byId("ab2", "Second")));
        assertEquals(new Answer.Pick("ab1"), decide(p));
    }

    @Test
    void picksTheFirstOption() {
        GamePrompt p = GamePrompt.chooseOption(1, "Choose a mode",
                List.of(Option.byKey("k1", "First"), Option.byKey("k2", "Second")), true);
        assertEquals(new Answer.Option("k1"), decide(p));
    }

    @Test
    void picksTheFirstPile() {
        assertEquals(new Answer.Pile(0),
                decide(GamePrompt.choosePile(1, "Pick a pile", List.of(), List.of())));
    }

    @Test
    void picksTheMinimumAmount() {
        assertEquals(new Answer.Amount(2),
                decide(GamePrompt.chooseAmount(1, "How many?", 2, 5)));
    }

    @Test
    void distributesTheSuggestedAmounts() {
        GamePrompt p = GamePrompt.distribute(1, "Distribute 4", 4, 0,
                List.of(new Among("r0", "Grizzly Bears", 0, 4, 3)), true);
        assertEquals(new Answer.Distribution(List.of(new Answer.Distribution.Share("r0", 3))),
                decide(p));
    }

    @Test
    void answersAPlayerRequestWithTheFirstOption() {
        GamePrompt p = GamePrompt.playerRequest(1, "Approve rollback?", "rollback",
                List.of(Option.byKey("yes", "Yes"), Option.byKey("no", "No")));
        assertEquals(new Answer.Option("yes"), decide(p));
    }

    // ---- minimal record builders ----

    private static Map<String, List<PlayableAction>> play(String id) {
        return Map.of(id, List.of(new PlayableAction(PlayableAction.PLAY, "Play")));
    }

    private static GamePrompt attackers(List<String> declared) {
        return GamePrompt.priority(1, "Select attackers", Map.of(),
                new Combat(Combat.ATTACKERS, List.of("a1", "a2"), declared, null));
    }

    private static GameState state(int lands, Card... hand) {
        List<Permanent> bf = new ArrayList<>();
        for (int i = 0; i < lands; i++) {
            bf.add(landPerm("land" + i));
        }
        Player me = new Player(ME, ME, true, 40, null, new Player.ManaPool(0, 0, 0, 0, 0, 0),
                90, hand.length, bf, List.of(), List.of(), List.of(), null, null, null, null);
        return new GameState("g", GameState.Status.ACTIVE, true,
                new GameState.Turn(1, Phase.PRECOMBAT_MAIN, Step.PRE_MAIN, ME, ME),
                List.of(me), List.of(), null, null, null,
                new GameState.Me(ME, List.of(hand), null));
    }

    private static Permanent landPerm(String id) {
        return new Permanent(id, "Island", "SET", "1", null, 0, List.of("LAND"), List.of(),
                List.of(), List.of(), List.of(), null, null, null, null, null, null, null, ME,
                false, null, null, null, null, null, null, null, null, null);
    }

    private static Card creature(String id) {
        return new Card(id, id, "SET", "1", null, 0, List.of("CREATURE"), List.of(), List.of(),
                List.of(), List.of(), null, null, null, null, null, null, null, null, null);
    }
}
