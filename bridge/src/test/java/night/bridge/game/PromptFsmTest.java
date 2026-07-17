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
    void wholeSetSubmissionIsRejectedInM2() {
        presentTargets(true);
        assertRejected(fsm.answer(1, new Answer.Picks(List.of(CANDIDATE))), ErrorCode.INVALID_ANSWER);
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
}
