package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Dismissal of a prompt (protocol §8): answered by this seat, superseded by
 * a newer prompt, or mooted by game end.
 */
public record PromptDone(
        long seq,
        String gameId,
        long promptId,
        Reason reason) implements ServerMsg {

    public enum Reason {
        @JsonProperty("answered") ANSWERED,
        @JsonProperty("superseded") SUPERSEDED,
        @JsonProperty("gameOver") GAME_OVER
    }
}
