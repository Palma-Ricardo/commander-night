package night.bridge.game;

import mage.constants.ManaType;
import night.bridge.proto.Answer;
import night.bridge.proto.ErrorCode;
import night.bridge.proto.GamePrompt;
import night.bridge.xmage.XmageAnswers;

import java.util.List;
import java.util.UUID;

/**
 * The pending-prompt state machine (design §8, M2 subset). Invariants: at
 * most one pending prompt; answers fenced by promptId (XMage's answer channel
 * is positional — a stale answer must never reach it); answer shape validated
 * against the pending kind before anything is sent.
 *
 * <p>M2 kinds: confirm, priority, chooseTargets (one pick per round-trip —
 * protocol §8's incremental style; whole-set replay is M3), payMana.
 * Owned by the seat pump; not thread-safe by design (§4).
 */
public final class PromptFsm {

    public sealed interface Outcome {
        record Applied() implements Outcome {
        }

        record Rejected(ErrorCode code, String message) implements Outcome {
        }
    }

    private final XmageAnswers answers;
    private long nextPromptId;
    private GamePrompt pending;

    public PromptFsm(XmageAnswers answers) {
        this.answers = answers;
    }

    public long nextPromptId() {
        return ++nextPromptId;
    }

    public GamePrompt pending() {
        return pending;
    }

    /** Returns the superseded prompt (if any) so the pump can emit promptDone for it. */
    public GamePrompt present(GamePrompt prompt) {
        GamePrompt superseded = pending;
        pending = prompt;
        return superseded;
    }

    public void clear() {
        pending = null;
    }

    public Outcome answer(long promptId, Answer answer) {
        if (pending == null) {
            return new Outcome.Rejected(ErrorCode.PROMPT_STALE, "no prompt is pending");
        }
        if (promptId != pending.promptId()) {
            return new Outcome.Rejected(ErrorCode.PROMPT_STALE,
                    "prompt " + promptId + " is not pending (current: " + pending.promptId() + ")");
        }
        Outcome outcome = apply(answer);
        if (outcome instanceof Outcome.Applied) {
            pending = null;
        }
        return outcome;
    }

    private Outcome apply(Answer answer) {
        return switch (pending.kind()) {
            case CONFIRM -> switch (answer) {
                case Answer.Confirm(boolean value) -> applied(() -> answers.bool(value));
                default -> invalid("a confirm prompt takes {type:'confirm'}");
            };
            case PRIORITY -> switch (answer) {
                case Answer.Confirm(boolean value) -> value
                        ? invalid("pass priority is {type:'confirm', value:false}")
                        : applied(() -> answers.bool(false));
                case Answer.Cancel() -> applied(() -> answers.bool(false));
                case Answer.Pick(String objectId) -> pickFrom(
                        pending.playable() == null ? List.of() : List.copyOf(pending.playable().keySet()),
                        objectId, "not a playable object");
                default -> invalid("priority takes {type:'object'} or a pass ({type:'confirm', value:false})");
            };
            case CHOOSE_TARGETS -> switch (answer) {
                case Answer.Pick(String objectId) ->
                        pickFrom(pending.candidates(), objectId, "not a candidate of this prompt");
                // done-with-current-picks; XMage re-prompts if the minimum isn't met
                case Answer.Confirm(boolean value) -> value
                        ? applied(() -> answers.bool(true))
                        : declineTargets();
                case Answer.Cancel() -> declineTargets();
                case Answer.Picks(List<String> ignored) ->
                        invalid("submit one pick at a time; whole-set answers land with the M3 replay");
                default -> invalid("chooseTargets takes {type:'object'}, done ({type:'confirm', value:true}) or cancel");
            };
            case PAY_MANA -> switch (answer) {
                case Answer.Pick(String objectId) -> pickFrom(pending.sources(), objectId, "not a mana source");
                case Answer.Mana(String color) -> mana(color);
                case Answer.Cancel() -> applied(() -> answers.bool(false));
                case Answer.Confirm(boolean value) -> value
                        ? invalid("payMana has no confirm; pick a source, spend pool mana, or cancel")
                        : applied(() -> answers.bool(false));
                default -> invalid("payMana takes {type:'object'}, {type:'mana'} or {type:'cancel'}");
            };
            default -> invalid("prompt kind " + pending.kind() + " is not answerable yet (M3)");
        };
    }

    private Outcome declineTargets() {
        if (Boolean.TRUE.equals(pending.required())) {
            return invalid("this selection is required");
        }
        return applied(() -> answers.bool(false));
    }

    /** Empty/absent candidate lists mean the bridge couldn't enumerate — XMage validates then. */
    private Outcome pickFrom(List<String> valid, String objectId, String reason) {
        UUID id;
        try {
            id = UUID.fromString(objectId);
        } catch (IllegalArgumentException e) {
            return invalid("objectId is not a UUID");
        }
        if (valid != null && !valid.isEmpty() && !valid.contains(objectId)) {
            return invalid(reason);
        }
        return applied(() -> answers.pick(id));
    }

    private Outcome mana(String color) {
        ManaType type = switch (color) {
            case "W" -> ManaType.WHITE;
            case "U" -> ManaType.BLUE;
            case "B" -> ManaType.BLACK;
            case "R" -> ManaType.RED;
            case "G" -> ManaType.GREEN;
            case "C" -> ManaType.COLORLESS;
            default -> null;
        };
        if (type == null) {
            return invalid("mana color must be one of W/U/B/R/G/C");
        }
        return applied(() -> answers.mana(type));
    }

    private Outcome applied(Runnable send) {
        send.run();
        return new Outcome.Applied();
    }

    private static Outcome invalid(String message) {
        return new Outcome.Rejected(ErrorCode.INVALID_ANSWER, message);
    }
}
