package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Answer to the pending prompt (protocol §8), fenced by {@code promptId} —
 * a stale id gets {@code PROMPT_STALE}, never a pass-through to XMage's
 * positional answer channel.
 */
public record GameAnswer(
        @JsonProperty(required = true) String id,
        @JsonProperty(required = true) String gameId,
        @JsonProperty(required = true) long promptId,
        @JsonProperty(required = true) Answer answer) implements ClientMsg {
}
