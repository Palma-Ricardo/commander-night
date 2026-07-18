package night.bridge.game;

import mage.constants.ManaType;
import mage.constants.PlayerAction;
import night.bridge.proto.Answer;
import night.bridge.proto.ErrorCode;
import night.bridge.proto.GamePrompt;
import night.bridge.xmage.XmageAnswers;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * The pending-prompt state machine (design §8, complete as of M3). Invariants:
 * at most one pending prompt; answers fenced by promptId (XMage's answer
 * channel is positional — a stale answer must never reach it); answer shape
 * validated against the pending kind before anything is sent.
 *
 * <p>States: idle, pending, and replaying — a whole-set {@code objects}
 * answer is fed to XMage one UUID at a time, with each continuation callback
 * matched by message key + advanced progress and consumed internally
 * ({@link #onDialog}). Any surprise aborts the replay back to a fresh prompt.
 *
 * <p>playerRequest prompts answer out-of-band ({@code sendPlayerAction}), so
 * presenting one <em>parks</em> the positional prompt it supersedes; the
 * park is revived under a fresh promptId once the request is answered
 * ({@link Outcome.Applied#revived}).
 *
 * <p>Owned by the seat pump; not thread-safe by design (§4).
 */
public final class PromptFsm {

    public sealed interface Outcome {
        /**
         * Answer accepted and sent (or dismissed): ack + promptDone(answered).
         * {@code revived} non-null → a parked positional prompt to re-present.
         */
        record Applied(GamePrompt revived) implements Outcome {
        }

        /** Whole-set picks accepted, replay in flight: ack only — promptDone follows resolution. */
        record ReplayStarted() implements Outcome {
        }

        record Rejected(ErrorCode code, String message) implements Outcome {
        }
    }

    /** What the pump must do with an incoming dialog prompt (§8 replay rules). */
    public sealed interface Flow {
        /** No replay in flight — present normally. */
        record Present() implements Flow {
        }

        /** Replay continuation consumed (next UUID sent) — emit nothing. */
        record Consumed() implements Flow {
        }

        /** Replay finished (done-boolean sent): promptDone(answered) for the compound prompt. */
        record Completed(long promptId) implements Flow {
        }

        /** Replay finished silently (XMage moved on): promptDone(answered), then present. */
        record CompletedThenPresent(long promptId) implements Flow {
        }

        /** Replay aborted (a pick was rejected / surprise ask): promptDone(superseded), then present. */
        record Aborted(long promptId) implements Flow {
        }
    }

    private static final Pattern PROGRESS_CLAUSE =
            Pattern.compile("\\(?selected \\d+ of \\d+\\)?", Pattern.CASE_INSENSITIVE);
    static final String DISMISS_KEY = "dismiss";

    private static final class Replay {
        final String messageKey;
        final ArrayDeque<UUID> queue;
        int expectedChosen;

        Replay(String messageKey, ArrayDeque<UUID> queue, int expectedChosen) {
            this.messageKey = messageKey;
            this.queue = queue;
            this.expectedChosen = expectedChosen;
        }
    }

    private final XmageAnswers answers;
    private long nextPromptId;
    private GamePrompt pending;
    /** playerRequest side data (relatedUserId) — rides the PlayerAction send, never the wire. */
    private UUID pendingRequestData;
    /** Positional prompt shelved by an out-of-band playerRequest (§8). */
    private GamePrompt parked;
    private Replay replay;

    public PromptFsm(XmageAnswers answers) {
        this.answers = answers;
    }

    public long nextPromptId() {
        return ++nextPromptId;
    }

    public GamePrompt pending() {
        return pending;
    }

    public boolean replaying() {
        return replay != null;
    }

    /** Returns the superseded prompt (if any) so the pump can emit promptDone for it. */
    public GamePrompt present(GamePrompt prompt) {
        return present(prompt, null);
    }

    public GamePrompt present(GamePrompt prompt, UUID requestData) {
        GamePrompt superseded = pending;
        if (prompt.kind() == GamePrompt.Kind.PLAYER_REQUEST
                && pending != null && pending.kind() != GamePrompt.Kind.PLAYER_REQUEST) {
            parked = pending;
        } else {
            // a positional ask is the server's current truth — any park is stale
            parked = null;
        }
        pending = prompt;
        pendingRequestData = prompt.kind() == GamePrompt.Kind.PLAYER_REQUEST ? requestData : null;
        return superseded;
    }

    public void clear() {
        pending = null;
        pendingRequestData = null;
        parked = null;
        replay = null;
    }

    /**
     * Replay interception (§8): every translated positional dialog passes
     * through here before presentation. Continuations are consumed (the next
     * queued UUID or the final done-boolean is sent); anything else while
     * replaying resolves the replay first.
     */
    public Flow onDialog(GamePrompt incoming) {
        if (replay == null) {
            return new Flow.Present();
        }
        long compoundId = pending.promptId();
        boolean matches = incoming.kind() == GamePrompt.Kind.CHOOSE_TARGETS
                && replay.messageKey.equals(messageKey(incoming.message()))
                && incoming.progress() != null
                && incoming.progress().chosen() == replay.expectedChosen;
        if (matches) {
            if (!replay.queue.isEmpty()) {
                UUID next = replay.queue.poll();
                replay.expectedChosen++;
                answers.pick(next);
                return new Flow.Consumed();
            }
            // all picks accepted; XMage asks once more → done with the chosen set
            replay = null;
            pending = null;
            answers.bool(true);
            return new Flow.Completed(compoundId);
        }
        if (replay.queue.isEmpty()) {
            // all picks sent and XMage moved on — the replay succeeded
            replay = null;
            pending = null;
            return new Flow.CompletedThenPresent(compoundId);
        }
        // a pick was rejected or an unrelated ask barged in — surface reality (§8)
        replay = null;
        pending = null;
        return new Flow.Aborted(compoundId);
    }

    public Outcome answer(long promptId, Answer answer) {
        if (pending == null) {
            return new Outcome.Rejected(ErrorCode.PROMPT_STALE, "no prompt is pending");
        }
        if (promptId != pending.promptId()) {
            return new Outcome.Rejected(ErrorCode.PROMPT_STALE,
                    "prompt " + promptId + " is not pending (current: " + pending.promptId() + ")");
        }
        if (replay != null) {
            return new Outcome.Rejected(ErrorCode.PROMPT_STALE,
                    "this prompt's answer was already submitted and is being applied");
        }
        Outcome outcome = apply(answer);
        if (outcome instanceof Outcome.Applied) {
            boolean wasRequest = pending.kind() == GamePrompt.Kind.PLAYER_REQUEST;
            pending = null;
            pendingRequestData = null;
            if (wasRequest && parked != null) {
                GamePrompt revived = parked.withPromptId(nextPromptId());
                parked = null;
                return new Outcome.Applied(revived);
            }
            parked = null;
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
                case Answer.Picks(List<String> objectIds) -> beginReplay(objectIds);
                default -> invalid("chooseTargets takes {type:'object'}, {type:'objects'}, "
                        + "done ({type:'confirm', value:true}) or cancel");
            };
            case CHOOSE_ABILITY -> switch (answer) {
                case Answer.Pick(String objectId) ->
                        pickFrom(optionIds(), objectId, "not an offered ability");
                default -> invalid("chooseAbility takes {type:'object'} with an offered ability id");
            };
            case CHOOSE_OPTION -> switch (answer) {
                case Answer.Option(String key) -> optionKeys().contains(key)
                        ? applied(() -> answers.text(key))
                        : invalid("not an offered option");
                // empty string = decline (HumanPlayer.choose cancels a non-required choice on it)
                case Answer.Cancel() -> Boolean.TRUE.equals(pending.required())
                        ? invalid("this choice is required")
                        : applied(() -> answers.text(""));
                default -> invalid("chooseOption takes {type:'option'} (or cancel when optional)");
            };
            case CHOOSE_PILE -> switch (answer) {
                // XMage's channel: boolean true = pile 1 (protocol §15)
                case Answer.Pile(int index) -> index == 0 || index == 1
                        ? applied(() -> answers.bool(index == 0))
                        : invalid("pile index must be 0 or 1");
                default -> invalid("choosePile takes {type:'pile', index:0|1}");
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
            case CHOOSE_AMOUNT -> switch (answer) {
                case Answer.Amount(long value) -> value >= pending.min() && value <= pending.max()
                        ? applied(() -> answers.integer((int) value))
                        : invalid("value must be between " + pending.min() + " and " + pending.max());
                // GAME_GET_AMOUNT has no decline channel — XMage would re-ask forever (§8)
                default -> invalid("chooseAmount takes {type:'number'} in [min, max]; it cannot be cancelled");
            };
            case DISTRIBUTE -> switch (answer) {
                case Answer.Distribution(List<Answer.Distribution.Share> amounts) -> distribution(amounts);
                case Answer.Cancel() -> Boolean.TRUE.equals(pending.canCancel())
                        ? applied(() -> answers.bool(false))
                        : invalid("this distribution cannot be cancelled");
                default -> invalid("distribute takes {type:'distribution'} with one amount per row");
            };
            case PLAYER_REQUEST -> switch (answer) {
                case Answer.Option(String key) -> playerRequest(key);
                // closing the dialog without choosing — same as a no-action button
                case Answer.Cancel() -> applied(() -> {
                });
                default -> invalid("playerRequest takes {type:'option'}");
            };
        };
    }

    /**
     * Whole-set submission (§8): validate everything up front, send the first
     * UUID, queue the rest for {@link #onDialog} continuation matching.
     */
    private Outcome beginReplay(List<String> objectIds) {
        if (objectIds == null || objectIds.isEmpty()) {
            return invalid("objectIds must be a non-empty list");
        }
        if (new HashSet<>(objectIds).size() != objectIds.size()) {
            return invalid("objectIds must not repeat");
        }
        List<UUID> ids = new ArrayList<>(objectIds.size());
        for (String objectId : objectIds) {
            try {
                ids.add(UUID.fromString(objectId));
            } catch (IllegalArgumentException e) {
                return invalid("objectId is not a UUID: " + objectId);
            }
        }
        List<String> valid = pending.candidates();
        if (valid != null && !valid.isEmpty() && !valid.containsAll(objectIds)) {
            return invalid("not candidates of this prompt");
        }
        int already = pending.progress() == null ? 0 : pending.progress().chosen();
        if (pending.max() != null && already + ids.size() > pending.max()) {
            return invalid("too many targets: " + already + " chosen + " + ids.size()
                    + " submitted > max " + pending.max());
        }
        ArrayDeque<UUID> queue = new ArrayDeque<>(ids);
        UUID first = queue.poll();
        replay = new Replay(messageKey(pending.message()), queue, already + 1);
        answers.pick(first);
        return new Outcome.ReplayStarted();
    }

    private Outcome playerRequest(String key) {
        if (!optionKeys().contains(key)) {
            return invalid("not an offered option");
        }
        if (DISMISS_KEY.equals(key)) {
            return applied(() -> {
            });
        }
        PlayerAction action;
        try {
            action = PlayerAction.valueOf(key);
        } catch (IllegalArgumentException e) {
            return invalid("not an offered option");
        }
        UUID data = pendingRequestData;
        return applied(() -> answers.action(action, data));
    }

    private Outcome distribution(List<Answer.Distribution.Share> amounts) {
        List<GamePrompt.Among> rows = pending.among() == null ? List.of() : pending.among();
        if (amounts == null || amounts.size() != rows.size()) {
            return invalid("provide exactly one amount per row (" + rows.size() + " rows)");
        }
        Map<String, Long> byId = new HashMap<>();
        for (Answer.Distribution.Share share : amounts) {
            if (byId.put(share.id(), share.amount()) != null) {
                return invalid("duplicate row id " + share.id());
            }
        }
        long sum = 0;
        StringBuilder joined = new StringBuilder();
        for (GamePrompt.Among row : rows) {
            Long amount = byId.get(row.id());
            if (amount == null) {
                return invalid("missing amount for row " + row.id());
            }
            if ((row.min() != null && amount < row.min()) || (row.max() != null && amount > row.max())) {
                return invalid("amount " + amount + " for '" + row.label() + "' is outside ["
                        + row.min() + ", " + row.max() + "]");
            }
            sum += amount;
            if (!joined.isEmpty()) {
                joined.append(' ');
            }
            joined.append(amount);
        }
        if ((pending.min() != null && sum < pending.min())
                || (pending.total() != null && sum > pending.total())) {
            return invalid("amounts must total between " + pending.min() + " and " + pending.total()
                    + ", got " + sum);
        }
        // XMage's PickMultiNumberDialog wire format: space-joined, one int per row (§15)
        String answer = joined.toString();
        return applied(() -> answers.text(answer));
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

    private List<String> optionIds() {
        if (pending.options() == null) {
            return List.of();
        }
        return pending.options().stream().map(GamePrompt.Option::id).toList();
    }

    private List<String> optionKeys() {
        if (pending.options() == null) {
            return List.of();
        }
        return pending.options().stream().map(GamePrompt.Option::key).toList();
    }

    /** The message with its "(selected k of n)" clause removed — replay continuation identity. */
    private static String messageKey(String message) {
        if (message == null) {
            return "";
        }
        return PROGRESS_CLAUSE.matcher(message).replaceAll("").replaceAll("\\s+", " ").strip();
    }

    private Outcome applied(Runnable send) {
        send.run();
        return new Outcome.Applied(null);
    }

    private static Outcome invalid(String message) {
        return new Outcome.Rejected(ErrorCode.INVALID_ANSWER, message);
    }
}
