package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;
import night.bridge.proto.state.Card;

import java.util.List;
import java.util.Map;

/**
 * A server ask (protocol §8): one wire type, discriminated by {@code kind},
 * with kind-specific fields flattened beside the common ones. Jackson can't
 * express a second, flattened discriminator inside a {@code t}-typed message
 * (&#64;JsonUnwrapped and polymorphism don't compose), so this is a single
 * record with nullable kind fields; the static factories are the only
 * constructors used, and each fills exactly its kind's fields.
 *
 * <p>All selectable-object hints live here, never in game state (§6).
 * {@code seq} is stamped at emit time — a pending prompt re-emitted on resume
 * keeps its {@code promptId} but gets a fresh {@code seq} ({@link #withSeq}).
 */
public record GamePrompt(
        long seq,
        String gameId,
        long promptId,
        String message,
        Kind kind,
        // confirm
        String yesText,
        String noText,
        // priority
        Map<String, List<PlayableAction>> playable,
        Boolean canPass,
        // chooseTargets
        List<String> candidates,
        Integer min,
        Integer max,
        Boolean required,
        String zone,
        Progress progress,
        List<Card> cards,
        // payMana
        String remaining,
        List<String> sources,
        Boolean canCancel) implements ServerMsg {

    public enum Kind {
        @JsonProperty("confirm") CONFIRM,
        @JsonProperty("priority") PRIORITY,
        @JsonProperty("chooseTargets") CHOOSE_TARGETS,
        @JsonProperty("chooseAbility") CHOOSE_ABILITY,
        @JsonProperty("chooseOption") CHOOSE_OPTION,
        @JsonProperty("choosePile") CHOOSE_PILE,
        @JsonProperty("payMana") PAY_MANA,
        @JsonProperty("chooseAmount") CHOOSE_AMOUNT,
        @JsonProperty("distribute") DISTRIBUTE,
        @JsonProperty("playerRequest") PLAYER_REQUEST
    }

    /** One thing that can be done with a playable object at priority. */
    public record PlayableAction(String kind, String text) {

        public static final String MANA = "mana";
        public static final String PLAY = "play";
        public static final String CAST = "cast";
        public static final String ABILITY = "ability";
    }

    /** "selected 1 of 3", parsed out of XMage's message text. */
    public record Progress(int chosen, int of) {
    }

    public static GamePrompt confirm(long promptId, String message, String yesText, String noText) {
        return new GamePrompt(0, null, promptId, message, Kind.CONFIRM, yesText, noText,
                null, null, null, null, null, null, null, null, null, null, null, null);
    }

    public static GamePrompt priority(long promptId, String message,
                                      Map<String, List<PlayableAction>> playable) {
        return new GamePrompt(0, null, promptId, message, Kind.PRIORITY, null, null,
                playable, true, null, null, null, null, null, null, null, null, null, null);
    }

    public static GamePrompt chooseTargets(long promptId, String message, List<String> candidates,
                                           int min, int max, boolean required, String zone,
                                           Progress progress, List<Card> cards) {
        return new GamePrompt(0, null, promptId, message, Kind.CHOOSE_TARGETS, null, null,
                null, null, candidates, min, max, required, zone, progress, cards, null, null, null);
    }

    public static GamePrompt payMana(long promptId, String message, String remaining,
                                     List<String> sources, boolean canCancel) {
        return new GamePrompt(0, null, promptId, message, Kind.PAY_MANA, null, null,
                null, null, null, null, null, null, null, null, null, remaining, sources, canCancel);
    }

    /** Stamp the per-seat event seq and game id at emit time. */
    public GamePrompt emitted(long seq, String gameId) {
        return new GamePrompt(seq, gameId, promptId, message, kind, yesText, noText,
                playable, canPass, candidates, min, max, required, zone, progress, cards,
                remaining, sources, canCancel);
    }

    /** Alias of {@link #emitted} for resume re-emission readability. */
    public GamePrompt withSeq(long seq) {
        return emitted(seq, gameId);
    }
}
