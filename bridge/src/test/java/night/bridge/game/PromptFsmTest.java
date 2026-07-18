package night.bridge.game;

import mage.constants.ManaType;
import mage.remote.Session;
import night.bridge.proto.Answer;
import night.bridge.proto.ErrorCode;
import night.bridge.proto.GamePrompt;
import night.bridge.xmage.XmageAnswers;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Design §13 FSM tier: scripted prompts against a recording
 * {@link mage.remote.Session} proxy, asserting the exact sendPlayer* calls —
 * the invariant under test is that XMage's positional answer channel only
 * ever receives validated, promptId-fenced answers.
 */
class PromptFsmTest {

    private static final UUID GAME = UUID.fromString("00000000-0000-0000-0000-00000000aaaa");
    private static final UUID PLAYER = UUID.fromString("00000000-0000-0000-0000-00000000bbbb");
    private static final String CANDIDATE = "11111111-1111-1111-1111-111111111111";
    private static final String OTHER = "22222222-2222-2222-2222-222222222222";

    private record Sent(String method, List<Object> args) {
    }

    private final List<Sent> sent = new ArrayList<>();
    private PromptFsm fsm;

    @BeforeEach
    void setUp() {
        Session session = (Session) Proxy.newProxyInstance(
                Session.class.getClassLoader(), new Class<?>[]{Session.class},
                (proxy, method, args) -> {
                    if (method.getName().startsWith("sendPlayer")) {
                        sent.add(new Sent(method.getName(),
                                args == null ? List.of() : Arrays.asList(args)));
                        return true;
                    }
                    Class<?> r = method.getReturnType();
                    return r == boolean.class ? false : r == int.class ? 0 : null;
                });
        fsm = new PromptFsm(new XmageAnswers(session, GAME, PLAYER));
    }

    private Sent lastSent() {
        assertEquals(1, sent.size(), "expected exactly one answer sent");
        return sent.getFirst();
    }

    private void assertRejected(PromptFsm.Outcome outcome, ErrorCode code) {
        PromptFsm.Outcome.Rejected r = assertInstanceOf(PromptFsm.Outcome.Rejected.class, outcome);
        assertEquals(code, r.code());
        assertTrue(sent.isEmpty(), "a rejected answer must never reach XMage; sent=" + sent);
    }

    // ---- fencing ----

    @Test
    void noPendingPromptIsStale() {
        assertRejected(fsm.answer(1, new Answer.Confirm(true)), ErrorCode.PROMPT_STALE);
    }

    @Test
    void wrongPromptIdIsStaleAndNothingIsSent() {
        fsm.present(GamePrompt.confirm(fsm.nextPromptId(), "Mulligan?", null, null));
        assertRejected(fsm.answer(99, new Answer.Confirm(true)), ErrorCode.PROMPT_STALE);
        // the prompt is still answerable afterwards
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(1, new Answer.Confirm(true)));
    }

    @Test
    void answeredPromptCannotBeAnsweredAgain() {
        fsm.present(GamePrompt.confirm(fsm.nextPromptId(), "Mulligan?", null, null));
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(1, new Answer.Confirm(false)));
        sent.clear();
        assertRejected(fsm.answer(1, new Answer.Confirm(false)), ErrorCode.PROMPT_STALE);
        assertNull(fsm.pending());
    }

    @Test
    void presentReturnsTheSupersededPrompt() {
        GamePrompt first = GamePrompt.confirm(fsm.nextPromptId(), "First?", null, null);
        assertNull(fsm.present(first));
        GamePrompt second = GamePrompt.confirm(fsm.nextPromptId(), "Second?", null, null);
        assertEquals(first, fsm.present(second));
        // an answer to the superseded prompt is fenced off
        assertRejected(fsm.answer(first.promptId(), new Answer.Confirm(true)), ErrorCode.PROMPT_STALE);
    }

    // ---- confirm ----

    @Test
    void confirmSendsBoolean() {
        fsm.present(GamePrompt.confirm(fsm.nextPromptId(), "Pass anyway?", null, null));
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(1, new Answer.Confirm(true)));
        assertEquals(new Sent("sendPlayerBoolean", List.of(GAME, true)), lastSent());
    }

    @Test
    void confirmRejectsObjectAnswers() {
        fsm.present(GamePrompt.confirm(fsm.nextPromptId(), "Mulligan?", null, null));
        assertRejected(fsm.answer(1, new Answer.Pick(CANDIDATE)), ErrorCode.INVALID_ANSWER);
    }

    // ---- priority ----

    private void presentPriority() {
        fsm.present(GamePrompt.priority(fsm.nextPromptId(), "Play spells and abilities",
                Map.of(CANDIDATE, List.of(new GamePrompt.PlayableAction("cast", "Cast Opt")))));
    }

    @Test
    void priorityPassSendsFalse() {
        presentPriority();
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(1, new Answer.Confirm(false)));
        assertEquals(new Sent("sendPlayerBoolean", List.of(GAME, false)), lastSent());
    }

    @Test
    void priorityActOnPlayableSendsUuid() {
        presentPriority();
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(1, new Answer.Pick(CANDIDATE)));
        assertEquals(new Sent("sendPlayerUUID", List.of(GAME, UUID.fromString(CANDIDATE))), lastSent());
    }

    @Test
    void priorityRejectsNonPlayableObject() {
        presentPriority();
        assertRejected(fsm.answer(1, new Answer.Pick(OTHER)), ErrorCode.INVALID_ANSWER);
    }

    @Test
    void priorityRejectsConfirmTrue() {
        presentPriority();
        assertRejected(fsm.answer(1, new Answer.Confirm(true)), ErrorCode.INVALID_ANSWER);
    }

    // ---- chooseTargets ----

    private void presentTargets(boolean required) {
        fsm.present(GamePrompt.chooseTargets(fsm.nextPromptId(), "Select target creature",
                List.of(CANDIDATE), required ? 1 : 0, 1, required, null, null, null));
    }

    @Test
    void targetPickSendsUuid() {
        presentTargets(true);
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(1, new Answer.Pick(CANDIDATE)));
        assertEquals(new Sent("sendPlayerUUID", List.of(GAME, UUID.fromString(CANDIDATE))), lastSent());
    }

    @Test
    void targetPickOutsideCandidatesIsInvalid() {
        presentTargets(true);
        assertRejected(fsm.answer(1, new Answer.Pick(OTHER)), ErrorCode.INVALID_ANSWER);
    }

    @Test
    void requiredTargetsCannotBeCancelled() {
        presentTargets(true);
        assertRejected(fsm.answer(1, new Answer.Cancel()), ErrorCode.INVALID_ANSWER);
    }

    @Test
    void optionalTargetsCancelSendsFalse() {
        presentTargets(false);
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(1, new Answer.Cancel()));
        assertEquals(new Sent("sendPlayerBoolean", List.of(GAME, false)), lastSent());
    }

    @Test
    void targetsDoneSendsTrue() {
        presentTargets(false);
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(1, new Answer.Confirm(true)));
        assertEquals(new Sent("sendPlayerBoolean", List.of(GAME, true)), lastSent());
    }

    @Test
    void singleItemWholeSetEntersReplayAndResolvesOnTheNextAsk() {
        presentTargets(true);
        assertInstanceOf(PromptFsm.Outcome.ReplayStarted.class,
                fsm.answer(1, new Answer.Picks(List.of(CANDIDATE))));
        assertEquals(new Sent("sendPlayerUUID", List.of(GAME, UUID.fromString(CANDIDATE))), lastSent());
        // single-target prompts carry no progress: any next ask resolves the replay silently
        assertInstanceOf(PromptFsm.Flow.CompletedThenPresent.class,
                fsm.onDialog(GamePrompt.confirm(99, "Pass anyway?", null, null)));
    }

    @Test
    void unknownCandidateListAcceptsAnyPick() {
        // The bridge couldn't enumerate candidates (battlefield-highlight case):
        // XMage stays the validator; the FSM must not block.
        fsm.present(GamePrompt.chooseTargets(fsm.nextPromptId(), "Select target",
                List.of(), 1, 1, true, null, null, null));
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(1, new Answer.Pick(OTHER)));
        assertEquals("sendPlayerUUID", lastSent().method());
    }

    // ---- payMana ----

    private void presentPayMana() {
        fsm.present(GamePrompt.payMana(fsm.nextPromptId(), "Pay {1}{U}", "{1}{U}",
                List.of(CANDIDATE), true));
    }

    @Test
    void payManaSourceSendsUuid() {
        presentPayMana();
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(1, new Answer.Pick(CANDIDATE)));
        assertEquals(new Sent("sendPlayerUUID", List.of(GAME, UUID.fromString(CANDIDATE))), lastSent());
    }

    @Test
    void payManaPoolSpendSendsManaType() {
        presentPayMana();
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(1, new Answer.Mana("U")));
        assertEquals(new Sent("sendPlayerManaType", List.of(GAME, PLAYER, ManaType.BLUE)), lastSent());
    }

    @Test
    void payManaBadColorIsInvalid() {
        presentPayMana();
        assertRejected(fsm.answer(1, new Answer.Mana("X")), ErrorCode.INVALID_ANSWER);
    }

    @Test
    void payManaCancelSendsFalse() {
        presentPayMana();
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(1, new Answer.Cancel()));
        assertEquals(new Sent("sendPlayerBoolean", List.of(GAME, false)), lastSent());
    }

    @Test
    void malformedUuidIsInvalidNotAnException() {
        presentPayMana();
        assertRejected(fsm.answer(1, new Answer.Pick("not-a-uuid")), ErrorCode.INVALID_ANSWER);
    }

    // ---- chooseAbility ----

    @Test
    void chooseAbilityPickSendsUuidAndValidatesAgainstOptions() {
        fsm.present(GamePrompt.chooseAbility(fsm.nextPromptId(), "Choose spell or ability",
                List.of(GamePrompt.Option.byId(CANDIDATE, "1. Cast Far"))));
        assertRejected(fsm.answer(1, new Answer.Pick(OTHER)), ErrorCode.INVALID_ANSWER);
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(1, new Answer.Pick(CANDIDATE)));
        assertEquals(new Sent("sendPlayerUUID", List.of(GAME, UUID.fromString(CANDIDATE))), lastSent());
    }

    // ---- chooseOption ----

    private void presentOption(boolean required) {
        fsm.present(GamePrompt.chooseOption(fsm.nextPromptId(), "Choose a creature type",
                List.of(GamePrompt.Option.byKey("Elf", "Elf"),
                        GamePrompt.Option.byKey("Shade", "Shade")), required));
    }

    @Test
    void chooseOptionSendsTheKeyAsString() {
        presentOption(true);
        assertRejected(fsm.answer(1, new Answer.Option("Dragon")), ErrorCode.INVALID_ANSWER);
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(1, new Answer.Option("Shade")));
        assertEquals(new Sent("sendPlayerString", List.of(GAME, "Shade")), lastSent());
    }

    @Test
    void chooseOptionCancelSendsEmptyStringOnlyWhenOptional() {
        presentOption(true);
        assertRejected(fsm.answer(1, new Answer.Cancel()), ErrorCode.INVALID_ANSWER);
        presentOption(false);
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(2, new Answer.Cancel()));
        assertEquals(new Sent("sendPlayerString", List.of(GAME, "")), lastSent());
    }

    // ---- choosePile ----

    @Test
    void choosePileSendsBooleanTrueForPileZero() {
        fsm.present(GamePrompt.choosePile(fsm.nextPromptId(), "Choose a pile", List.of(), List.of()));
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(1, new Answer.Pile(0)));
        assertEquals(new Sent("sendPlayerBoolean", List.of(GAME, true)), lastSent());
        fsm.present(GamePrompt.choosePile(fsm.nextPromptId(), "Choose a pile", List.of(), List.of()));
        sent.clear();
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(2, new Answer.Pile(1)));
        assertEquals(new Sent("sendPlayerBoolean", List.of(GAME, false)), lastSent());
    }

    @Test
    void choosePileRejectsOtherIndexes() {
        fsm.present(GamePrompt.choosePile(fsm.nextPromptId(), "Choose a pile", List.of(), List.of()));
        assertRejected(fsm.answer(1, new Answer.Pile(2)), ErrorCode.INVALID_ANSWER);
    }

    // ---- chooseAmount ----

    @Test
    void chooseAmountSendsIntegerWithinBounds() {
        fsm.present(GamePrompt.chooseAmount(fsm.nextPromptId(), "Announce X", 0, 20));
        assertRejected(fsm.answer(1, new Answer.Amount(21)), ErrorCode.INVALID_ANSWER);
        assertRejected(fsm.answer(1, new Answer.Amount(-1)), ErrorCode.INVALID_ANSWER);
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(1, new Answer.Amount(7)));
        assertEquals(new Sent("sendPlayerInteger", List.of(GAME, 7)), lastSent());
    }

    @Test
    void chooseAmountCannotBeCancelled() {
        fsm.present(GamePrompt.chooseAmount(fsm.nextPromptId(), "Announce X", 0, 20));
        assertRejected(fsm.answer(1, new Answer.Cancel()), ErrorCode.INVALID_ANSWER);
    }

    // ---- distribute ----

    private void presentDistribute(boolean canCancel) {
        fsm.present(GamePrompt.distribute(fsm.nextPromptId(), "Assign damage among targets", 4, 4,
                List.of(new GamePrompt.Among("0", "Goblin", 0, 4, 2),
                        new GamePrompt.Among("1", "Elf", 0, 4, 2)), canCancel));
    }

    @Test
    void distributionJoinsAmountsInRowOrder() {
        presentDistribute(false);
        // client may send rows in any order; the wire string follows prompt row order
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(1, new Answer.Distribution(
                List.of(new Answer.Distribution.Share("1", 3), new Answer.Distribution.Share("0", 1)))));
        assertEquals(new Sent("sendPlayerString", List.of(GAME, "1 3")), lastSent());
    }

    @Test
    void distributionValidatesRowsAndTotals() {
        presentDistribute(false);
        // missing row 1
        assertRejected(fsm.answer(1, new Answer.Distribution(
                        List.of(new Answer.Distribution.Share("0", 4)))),
                ErrorCode.INVALID_ANSWER);
        // rows outside their per-row bounds
        assertRejected(fsm.answer(1, new Answer.Distribution(
                        List.of(new Answer.Distribution.Share("0", 5),
                                new Answer.Distribution.Share("1", -1)))),
                ErrorCode.INVALID_ANSWER);
        // sums to 2, needs exactly 4
        assertRejected(fsm.answer(1, new Answer.Distribution(
                        List.of(new Answer.Distribution.Share("0", 1),
                                new Answer.Distribution.Share("1", 1)))),
                ErrorCode.INVALID_ANSWER);
    }

    @Test
    void distributionCancelHonoursCanCancel() {
        presentDistribute(false);
        assertRejected(fsm.answer(1, new Answer.Cancel()), ErrorCode.INVALID_ANSWER);
        presentDistribute(true);
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(2, new Answer.Cancel()));
        assertEquals(new Sent("sendPlayerBoolean", List.of(GAME, false)), lastSent());
    }

    // ---- playerRequest ----

    private static final UUID RELATED = UUID.fromString("00000000-0000-0000-0000-00000000cccc");

    private GamePrompt presentRequest() {
        GamePrompt p = GamePrompt.playerRequest(fsm.nextPromptId(), "Roll back to turn 3?",
                "Rollback request", List.of(
                        GamePrompt.Option.byKey("ADD_PERMISSION_TO_ROLLBACK_TURN", "Allow"),
                        GamePrompt.Option.byKey("DENY_PERMISSION_TO_ROLLBACK_TURN", "Deny"),
                        GamePrompt.Option.byKey(PromptFsm.DISMISS_KEY, "Close")));
        fsm.present(p, RELATED);
        return p;
    }

    @Test
    void playerRequestOptionSendsThePlayerActionWithRelatedUser() {
        presentRequest();
        PromptFsm.Outcome.Applied a = assertInstanceOf(PromptFsm.Outcome.Applied.class,
                fsm.answer(1, new Answer.Option("ADD_PERMISSION_TO_ROLLBACK_TURN")));
        assertNull(a.revived(), "nothing was parked");
        assertEquals(new Sent("sendPlayerAction",
                List.of(mage.constants.PlayerAction.ADD_PERMISSION_TO_ROLLBACK_TURN, GAME, RELATED)), lastSent());
    }

    @Test
    void playerRequestDismissSendsNothing() {
        presentRequest();
        assertInstanceOf(PromptFsm.Outcome.Applied.class,
                fsm.answer(1, new Answer.Option(PromptFsm.DISMISS_KEY)));
        assertTrue(sent.isEmpty(), "dismiss must not touch XMage");
        assertNull(fsm.pending());
    }

    @Test
    void playerRequestRejectsUnofferedActions() {
        presentRequest();
        // CONCEDE is a real PlayerAction but was not a button on this dialog
        assertRejected(fsm.answer(1, new Answer.Option("CONCEDE")), ErrorCode.INVALID_ANSWER);
    }

    @Test
    void playerRequestParksAndRevivesThePositionalPrompt() {
        presentPriority();                      // promptId 1, positional
        GamePrompt request = GamePrompt.playerRequest(fsm.nextPromptId(), "Allow rollback?",
                "Rollback request", List.of(GamePrompt.Option.byKey("DENY_PERMISSION_TO_ROLLBACK_TURN", "Deny")));
        assertEquals(1, fsm.present(request, RELATED).promptId(), "priority prompt superseded");
        // the positional answer channel still awaits its answer — a stale priority answer stays fenced
        assertRejected(fsm.answer(1, new Answer.Confirm(false)), ErrorCode.PROMPT_STALE);
        PromptFsm.Outcome.Applied a = assertInstanceOf(PromptFsm.Outcome.Applied.class,
                fsm.answer(2, new Answer.Option("DENY_PERMISSION_TO_ROLLBACK_TURN")));
        assertNotNull(a.revived(), "the parked priority prompt must come back");
        assertEquals(GamePrompt.Kind.PRIORITY, a.revived().kind());
        assertEquals(3, a.revived().promptId(), "revival mints a fresh promptId");
        // and the revived prompt answers normally
        fsm.present(a.revived());
        sent.clear();
        assertInstanceOf(PromptFsm.Outcome.Applied.class, fsm.answer(3, new Answer.Confirm(false)));
        assertEquals(new Sent("sendPlayerBoolean", List.of(GAME, false)), lastSent());
    }

    @Test
    void positionalPromptDropsAStalePark() {
        presentPriority();
        presentRequest();                       // parks the priority prompt
        // a fresh positional ask arrives before the request is answered → park is stale
        fsm.present(GamePrompt.confirm(fsm.nextPromptId(), "Mulligan?", null, null));
        PromptFsm.Outcome.Applied a = assertInstanceOf(PromptFsm.Outcome.Applied.class,
                fsm.answer(3, new Answer.Confirm(true)));
        assertNull(a.revived(), "the superseded park must not resurface");
    }

    // ---- compound replay (§8) ----

    private static final String THIRD = "33333333-3333-3333-3333-333333333333";

    private GamePrompt targetsPrompt(long promptId, int chosen, int of) {
        return GamePrompt.chooseTargets(promptId,
                "Select target creatures (selected " + chosen + " of " + of + ")",
                List.of(CANDIDATE, OTHER, THIRD), 1, of, true, null,
                new GamePrompt.Progress(chosen, of), null);
    }

    @Test
    void wholeSetReplaySendsUuidsThenDoneBoolean() {
        fsm.present(targetsPrompt(fsm.nextPromptId(), 0, 3));
        assertInstanceOf(PromptFsm.Outcome.ReplayStarted.class,
                fsm.answer(1, new Answer.Picks(List.of(CANDIDATE, OTHER))));
        assertTrue(fsm.replaying());
        // continuation 1: XMage acknowledged the first pick
        assertInstanceOf(PromptFsm.Flow.Consumed.class, fsm.onDialog(targetsPrompt(99, 1, 3)));
        // all sent; XMage asks once more → done-boolean
        PromptFsm.Flow.Completed done = assertInstanceOf(PromptFsm.Flow.Completed.class,
                fsm.onDialog(targetsPrompt(99, 2, 3)));
        assertEquals(1, done.promptId());
        assertEquals(List.of(
                        new Sent("sendPlayerUUID", List.of(GAME, UUID.fromString(CANDIDATE))),
                        new Sent("sendPlayerUUID", List.of(GAME, UUID.fromString(OTHER))),
                        new Sent("sendPlayerBoolean", List.of(GAME, true))),
                sent);
        assertNull(fsm.pending());
        assertTrue(!fsm.replaying());
    }

    @Test
    void replayCompletesSilentlyWhenXmageMovesOn() {
        fsm.present(targetsPrompt(fsm.nextPromptId(), 0, 2));
        assertInstanceOf(PromptFsm.Outcome.ReplayStarted.class,
                fsm.answer(1, new Answer.Picks(List.of(CANDIDATE, OTHER))));
        assertInstanceOf(PromptFsm.Flow.Consumed.class, fsm.onDialog(targetsPrompt(99, 1, 2)));
        // max reached — XMage proceeds straight to the next ask
        GamePrompt next = GamePrompt.confirm(fsm.nextPromptId(), "Pass anyway?", null, null);
        PromptFsm.Flow.CompletedThenPresent flow = assertInstanceOf(
                PromptFsm.Flow.CompletedThenPresent.class, fsm.onDialog(next));
        assertEquals(1, flow.promptId());
        assertEquals(List.of(
                        new Sent("sendPlayerUUID", List.of(GAME, UUID.fromString(CANDIDATE))),
                        new Sent("sendPlayerUUID", List.of(GAME, UUID.fromString(OTHER)))),
                sent, "no done-boolean when XMage already moved on");
    }

    @Test
    void unadvancedProgressAbortsTheReplay() {
        fsm.present(targetsPrompt(fsm.nextPromptId(), 0, 3));
        fsm.answer(1, new Answer.Picks(List.of(CANDIDATE, OTHER)));
        // XMage rejected the pick: same ask, progress did not advance
        PromptFsm.Flow.Aborted aborted = assertInstanceOf(PromptFsm.Flow.Aborted.class,
                fsm.onDialog(targetsPrompt(99, 0, 3)));
        assertEquals(1, aborted.promptId());
        assertEquals(1, sent.size(), "only the first UUID was ever sent");
        assertTrue(!fsm.replaying());
        assertNull(fsm.pending(), "the aborting prompt is presented by the pump, not the FSM");
    }

    @Test
    void unrelatedDialogMidQueueAbortsTheReplay() {
        fsm.present(targetsPrompt(fsm.nextPromptId(), 0, 3));
        fsm.answer(1, new Answer.Picks(List.of(CANDIDATE, OTHER)));
        assertInstanceOf(PromptFsm.Flow.Aborted.class,
                fsm.onDialog(GamePrompt.confirm(99, "Sacrifice a creature?", null, null)));
    }

    @Test
    void answersDuringReplayAreFenced() {
        fsm.present(targetsPrompt(fsm.nextPromptId(), 0, 3));
        fsm.answer(1, new Answer.Picks(List.of(CANDIDATE, OTHER)));
        sent.clear();
        assertRejected(fsm.answer(1, new Answer.Pick(THIRD)), ErrorCode.PROMPT_STALE);
    }

    @Test
    void picksAreValidatedBeforeAnythingIsSent() {
        fsm.present(targetsPrompt(fsm.nextPromptId(), 0, 2));
        assertRejected(fsm.answer(1, new Answer.Picks(List.of())), ErrorCode.INVALID_ANSWER);
        assertRejected(fsm.answer(1, new Answer.Picks(List.of(CANDIDATE, CANDIDATE))), ErrorCode.INVALID_ANSWER);
        assertRejected(fsm.answer(1, new Answer.Picks(
                List.of("44444444-4444-4444-4444-444444444444"))), ErrorCode.INVALID_ANSWER);
        assertRejected(fsm.answer(1, new Answer.Picks(List.of(CANDIDATE, OTHER, THIRD))),
                ErrorCode.INVALID_ANSWER); // 3 > max 2
        assertInstanceOf(PromptFsm.Outcome.ReplayStarted.class,
                fsm.answer(1, new Answer.Picks(List.of(CANDIDATE, OTHER))));
    }

    @Test
    void progressAlreadyChosenCountsAgainstMax() {
        fsm.present(targetsPrompt(fsm.nextPromptId(), 2, 3));
        assertRejected(fsm.answer(1, new Answer.Picks(List.of(CANDIDATE, OTHER))),
                ErrorCode.INVALID_ANSWER); // 2 chosen + 2 submitted > 3
        assertInstanceOf(PromptFsm.Outcome.ReplayStarted.class,
                fsm.answer(1, new Answer.Picks(List.of(CANDIDATE))));
    }
}
