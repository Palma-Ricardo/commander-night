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
 * constructors used, and each fills exactly its kind's fields. Some fields
 * are shared where the protocol shapes overlap: {@code min}/{@code max}
 * (chooseTargets, chooseAmount, distribute), {@code required} (chooseTargets,
 * chooseOption), {@code canCancel} (payMana, distribute), {@code options}
 * (chooseAbility, chooseOption, playerRequest).
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
        Combat combat,
        // chooseTargets (min/max also chooseAmount + distribute; required also chooseOption)
        List<String> candidates,
        Integer min,
        Integer max,
        Boolean required,
        String zone,
        Progress progress,
        List<Card> cards,
        // payMana (canCancel also distribute)
        String remaining,
        List<String> sources,
        Boolean canCancel,
        // chooseAbility ({id,text}) / chooseOption ({key,text}) / playerRequest ({key,text})
        List<Option> options,
        // choosePile
        List<List<Card>> piles,
        // distribute
        Integer total,
        List<Among> among,
        // playerRequest
        String requestKey) implements ServerMsg {

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

    /**
     * Combat declaration riding a priority prompt (protocol §8): present iff
     * the GAME_SELECT was "Select attackers"/"Select blockers". XMage accepts
     * nothing but toggles on this ask, so {@code playable} is empty alongside.
     * One toggle per round trip; done declaring = a confirm of either value;
     * {@code special} is the shortcut button label ("All attack") when offered,
     * answered with option key {@value #SPECIAL_KEY}.
     */
    public record Combat(String role, List<String> candidates, List<String> declared,
                         String special) {

        public static final String ATTACKERS = "attackers";
        public static final String BLOCKERS = "blockers";
        public static final String SPECIAL_KEY = "special";
    }

    /** "selected 1 of 3", parsed out of XMage's message text. */
    public record Progress(int chosen, int of) {
    }

    /**
     * One selectable option. chooseAbility options carry {@code id} (an XMage
     * ability UUID); chooseOption/playerRequest options carry {@code key}
     * (a choice key / PlayerAction name). NON_NULL serialization keeps each
     * kind's wire shape exact (protocol §8).
     */
    public record Option(String id, String key, String text) {

        public static Option byId(String id, String text) {
            return new Option(id, null, text);
        }

        public static Option byKey(String key, String text) {
            return new Option(null, key, text);
        }
    }

    /** One distribute row; {@code id} is a bridge-synthesized row index (§8). */
    public record Among(String id, String label, Integer min, Integer max, Integer suggested) {
    }

    public static GamePrompt confirm(long promptId, String message, String yesText, String noText) {
        return new GamePrompt(0, null, promptId, message, Kind.CONFIRM, yesText, noText,
                null, null, null, null, null, null, null, null, null, null, null, null,
                null, null, null, null, null, null);
    }

    public static GamePrompt priority(long promptId, String message,
                                      Map<String, List<PlayableAction>> playable) {
        return priority(promptId, message, playable, null);
    }

    public static GamePrompt priority(long promptId, String message,
                                      Map<String, List<PlayableAction>> playable, Combat combat) {
        return new GamePrompt(0, null, promptId, message, Kind.PRIORITY, null, null,
                playable, true, combat, null, null, null, null, null, null, null, null, null,
                null, null, null, null, null, null);
    }

    public static GamePrompt chooseTargets(long promptId, String message, List<String> candidates,
                                           int min, int max, boolean required, String zone,
                                           Progress progress, List<Card> cards) {
        return new GamePrompt(0, null, promptId, message, Kind.CHOOSE_TARGETS, null, null,
                null, null, null, candidates, min, max, required, zone, progress, cards, null, null,
                null, null, null, null, null, null);
    }

    public static GamePrompt payMana(long promptId, String message, String remaining,
                                     List<String> sources, boolean canCancel) {
        return new GamePrompt(0, null, promptId, message, Kind.PAY_MANA, null, null,
                null, null, null, null, null, null, null, null, null, null, remaining, sources,
                canCancel, null, null, null, null, null);
    }

    public static GamePrompt chooseAbility(long promptId, String message, List<Option> options) {
        return new GamePrompt(0, null, promptId, message, Kind.CHOOSE_ABILITY, null, null,
                null, null, null, null, null, null, null, null, null, null, null, null,
                null, options, null, null, null, null);
    }

    public static GamePrompt chooseOption(long promptId, String message, List<Option> options,
                                          boolean required) {
        return new GamePrompt(0, null, promptId, message, Kind.CHOOSE_OPTION, null, null,
                null, null, null, null, null, null, required, null, null, null, null, null,
                null, options, null, null, null, null);
    }

    public static GamePrompt choosePile(long promptId, String message,
                                        List<Card> pile1, List<Card> pile2) {
        return new GamePrompt(0, null, promptId, message, Kind.CHOOSE_PILE, null, null,
                null, null, null, null, null, null, null, null, null, null, null, null,
                null, null, List.of(pile1, pile2), null, null, null);
    }

    public static GamePrompt chooseAmount(long promptId, String message, int min, int max) {
        return new GamePrompt(0, null, promptId, message, Kind.CHOOSE_AMOUNT, null, null,
                null, null, null, null, min, max, null, null, null, null, null, null,
                null, null, null, null, null, null);
    }

    public static GamePrompt distribute(long promptId, String message, int total, int min,
                                        List<Among> among, boolean canCancel) {
        return new GamePrompt(0, null, promptId, message, Kind.DISTRIBUTE, null, null,
                null, null, null, null, min, null, null, null, null, null, null, null,
                canCancel, null, null, total, among, null);
    }

    public static GamePrompt playerRequest(long promptId, String message, String requestKey,
                                           List<Option> options) {
        return new GamePrompt(0, null, promptId, message, Kind.PLAYER_REQUEST, null, null,
                null, null, null, null, null, null, null, null, null, null, null, null,
                null, options, null, null, null, requestKey);
    }

    /** Stamp the per-seat event seq and game id at emit time. */
    public GamePrompt emitted(long seq, String gameId) {
        return new GamePrompt(seq, gameId, promptId, message, kind, yesText, noText,
                playable, canPass, combat, candidates, min, max, required, zone, progress, cards,
                remaining, sources, canCancel, options, piles, total, among, requestKey);
    }

    /** Alias of {@link #emitted} for resume re-emission readability. */
    public GamePrompt withSeq(long seq) {
        return emitted(seq, gameId);
    }

    /** Same ask under a new id — reviving a prompt parked by a playerRequest (design §8). */
    public GamePrompt withPromptId(long promptId) {
        return new GamePrompt(seq, gameId, promptId, message, kind, yesText, noText,
                playable, canPass, combat, candidates, min, max, required, zone, progress, cards,
                remaining, sources, canCancel, options, piles, total, among, requestKey);
    }
}
