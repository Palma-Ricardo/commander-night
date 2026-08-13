package night.bridge.ai;

import night.bridge.proto.Answer;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.GamePrompt.Combat;
import night.bridge.proto.GamePrompt.PlayableAction;
import night.bridge.proto.state.Card;
import night.bridge.proto.state.CombatGroup;
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
 * The first heuristic pass over {@link FirstLegalMoveBrain}: it ranks priority
 * plays by impact, declares attacks and blocks by combat math, and aims attacks at
 * the weakest opponent (all other prompt kinds are delegated to the baseline).
 * Tests cover ranked play, the attack/block model, the defender choice, defensive
 * parsing, and delegation.
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

    // ---- block math ----

    @Test
    void blocksToKillAndSurvive() {
        // a 2/2 attacks me; my untapped 3/3 kills it (3>=2) and lives (3>2) — block.
        GameState state = blockState(20, List.of(creature("b1", 3, 3)), List.of(attacker("a1", 2, 2)));
        assertEquals(new Answer.Pick("b1"), brain.decide(state, blockers(List.of("b1"), List.of()), ctx));
    }

    @Test
    void takesAnEvenTradeOnDefense() {
        // a 3/3 attacks me; my 3/3 kills it but dies — an even trade takes no damage, so block.
        GameState state = blockState(20, List.of(creature("b1", 3, 3)), List.of(attacker("a1", 3, 3)));
        assertEquals(new Answer.Pick("b1"), brain.decide(state, blockers(List.of("b1"), List.of()), ctx));
    }

    @Test
    void doesNotChumpOrTradeDownWhenLifeIsSafe() {
        // a 4/4 attacks me; my only creature is a 2/2 — it can't kill it and I'm at 20,
        // so eat the 4 rather than throw the 2/2 away.
        GameState state = blockState(20, List.of(creature("b1", 2, 2)), List.of(attacker("a1", 4, 4)));
        assertEquals(new Answer.Confirm(true), brain.decide(state, blockers(List.of("b1"), List.of()), ctx));
    }

    @Test
    void chumpBlocksTheBiggestAttackerWhenFacingLethal() {
        // 6 incoming with me at 5 is lethal; my 1/1 can't kill the 6/6 but chumping saves the game.
        GameState state = blockState(5, List.of(creature("b1", 1, 1)), List.of(attacker("a1", 6, 6)));
        assertEquals(new Answer.Pick("b1"), brain.decide(state, blockers(List.of("b1"), List.of()), ctx));
    }

    @Test
    void keepsTheBiggerBlockerBackWhenASmallerOneWillDo() {
        // a 1/1 attacks; a 2/2 and a 5/5 both kill-and-survive it — spend the 2/2.
        GameState state = blockState(20,
                List.of(creature("small", 2, 2), creature("big", 5, 5)),
                List.of(attacker("a1", 1, 1)));
        assertEquals(new Answer.Pick("small"),
                brain.decide(state, blockers(List.of("small", "big"), List.of()), ctx));
    }

    @Test
    void groundCreatureDoesNotBlockAFlyer() {
        // a 2/2 flyer attacks; my 3/3 has no flying or reach — it can't block, so take it.
        GameState state = blockState(20,
                List.of(creature("b1", 3, 3)),
                List.of(attackerWithText("a1", 2, 2, "Flying")));
        assertEquals(new Answer.Confirm(true), brain.decide(state, blockers(List.of("b1"), List.of()), ctx));
    }

    @Test
    void reachCreatureBlocksAFlyer() {
        GameState state = blockState(20,
                List.of(creatureWithText("b1", 3, 3, "Reach")),
                List.of(attackerWithText("a1", 2, 2, "Flying")));
        assertEquals(new Answer.Pick("b1"), brain.decide(state, blockers(List.of("b1"), List.of()), ctx));
    }

    @Test
    void deathtouchDefeatsTheSurvivesCheck() {
        // my 5/5 would normally live through a 1/1, but deathtouch kills it — an even
        // trade of my 5/5 for their 1/1 is a trade-down, and I'm safe, so don't block.
        GameState state = blockState(20,
                List.of(creature("b1", 5, 5)),
                List.of(attackerWithText("a1", 1, 1, "Deathtouch")));
        assertEquals(new Answer.Confirm(true), brain.decide(state, blockers(List.of("b1"), List.of()), ctx));
    }

    @Test
    void assignsTheIntendedAttackerOnTheFollowUp() {
        // Two attackers; declaring the blocker first records which one it's for, and the
        // "Select attacker to block" follow-up honors that pairing.
        GameState state = blockState(20,
                List.of(creature("b1", 3, 3)),
                List.of(attacker("a1", 2, 2), attacker("a2", 9, 9)));
        // The 3/3 kills-and-survives the 2/2 (a1) but not the 9/9 — it should intend a1.
        assertEquals(new Answer.Pick("b1"), brain.decide(state, blockers(List.of("b1"), List.of()), ctx));
        assertEquals(new Answer.Pick("a1"),
                brain.decide(state, selectAttackerToBlock(List.of("a1", "a2")), ctx));
    }

    // ---- defender choice (hit the weakest player) ----

    @Test
    void attacksTheLowestLifeOpponent() {
        GameState state = tableState(List.of(
                seat(ME, 40, List.of()),
                seat("high", 30, List.of()),
                seat("low", 12, List.of()),
                seat("mid", 25, List.of())));
        assertEquals(new Answer.Pick("low"),
                brain.decide(state, selectDefender(List.of("high", "low", "mid")), ctx));
    }

    @Test
    void breaksLifeTiesTowardTheLeastDefendedPlayer() {
        // both at 15; the "open" seat has no untapped blockers, the "guarded" seat has two.
        GameState state = tableState(List.of(
                seat(ME, 40, List.of()),
                seat("guarded", 15, List.of(creature("g1", 2, 2), creature("g2", 2, 2))),
                seat("open", 15, List.of())));
        assertEquals(new Answer.Pick("open"),
                brain.decide(state, selectDefender(List.of("guarded", "open")), ctx));
    }

    @Test
    void skipsNonPlayerDefenderCandidates() {
        // a planeswalker permanent id sits among the candidates; the player still wins.
        GameState state = tableState(List.of(
                seat(ME, 40, List.of()),
                seat("opp", 22, List.of())));
        assertEquals(new Answer.Pick("opp"),
                brain.decide(state, selectDefender(List.of("some-planeswalker", "opp")), ctx));
    }

    @Test
    void fallsBackToTheFirstCandidateWhenNoPlayerIsADefender() {
        // only planeswalkers/battles are legal defenders — take the first, like the baseline.
        GameState state = tableState(List.of(seat(ME, 40, List.of())));
        assertEquals(new Answer.Pick("pw1"),
                brain.decide(state, selectDefender(List.of("pw1", "pw2")), ctx));
    }

    @Test
    void delegatesAnOrdinaryTargetPromptToTheBaseline() {
        GamePrompt p = GamePrompt.chooseTargets(1, "Choose up to 2", List.of("t1", "t2"),
                0, 2, false, "battlefield", new GamePrompt.Progress(0, 2), List.of());
        assertEquals(new Answer.Cancel(), brain.decide(combatState(List.of(), List.of()), p, ctx));
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

    private static GamePrompt blockers(List<String> candidates, List<String> declared) {
        return GamePrompt.priority(1, "Select blockers", Map.of(),
                new Combat(Combat.BLOCKERS, candidates, declared, null));
    }

    private static GamePrompt selectAttackerToBlock(List<String> attackerIds) {
        return GamePrompt.chooseTargets(1, "Select attacker to block", attackerIds,
                0, 1, false, null, null, List.of());
    }

    private static GamePrompt selectDefender(List<String> candidates) {
        return GamePrompt.chooseTargets(1, "Select a player, planeswalker, or battle to attack",
                candidates, 1, 1, true, null, null, List.of());
    }

    /** A table of seats (ME plus opponents) in the declare-attackers step. */
    private static GameState tableState(List<Player> players) {
        return new GameState("g", GameState.Status.ACTIVE, true,
                new GameState.Turn(1, Phase.COMBAT, Step.DECLARE_ATTACKERS, ME, ME),
                players, List.of(), null, null, null,
                new GameState.Me(ME, List.of(), null));
    }

    private static Player seat(String id, int life, List<Permanent> board) {
        return new Player(id, id, true, life, null, new Player.ManaPool(0, 0, 0, 0, 0, 0),
                90, 0, board, List.of(), List.of(), List.of(), null, null, null, null);
    }

    /** My {@code blockers} at {@code myLife}; each of {@code attackers} in its own group hitting me. */
    private static GameState blockState(int myLife, List<Permanent> blockers, List<Permanent> attackers) {
        Player me = new Player(ME, ME, true, myLife, null, new Player.ManaPool(0, 0, 0, 0, 0, 0),
                90, 0, blockers, List.of(), List.of(), List.of(), null, null, null, null);
        Player opp = new Player(OPP, OPP, true, 40, null, new Player.ManaPool(0, 0, 0, 0, 0, 0),
                90, 0, attackers, List.of(), List.of(), List.of(), null, null, null, null);
        List<CombatGroup> combat = new ArrayList<>();
        for (Permanent a : attackers) {
            combat.add(new CombatGroup(List.of(a.id()), ME, List.of(), false));
        }
        return new GameState("g", GameState.Status.ACTIVE, true,
                new GameState.Turn(1, Phase.COMBAT, Step.DECLARE_BLOCKERS, OPP, OPP),
                List.of(me, opp), List.of(), combat, null, null,
                new GameState.Me(ME, List.of(), null));
    }

    private static Permanent attacker(String id, int power, int toughness) {
        return creatureRaw(id, String.valueOf(power), String.valueOf(toughness));
    }

    private static Permanent attackerWithText(String id, int power, int toughness, String... text) {
        return creatureWithText(id, power, toughness, text);
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
