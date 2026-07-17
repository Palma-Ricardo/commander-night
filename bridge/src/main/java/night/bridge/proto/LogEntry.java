package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * One game-log line (protocol §10): plain text (XMage HTML stripped), with
 * {@code refs} carrying the card mentions extracted from the HTML's
 * object_id attributes so the client can link/hover them.
 */
public record LogEntry(
        long seq,
        String gameId,
        long ts,
        Kind kind,
        String turn,
        String text,
        List<Ref> refs,
        String playerId) implements ServerMsg {

    public enum Kind {
        @JsonProperty("game") GAME,
        @JsonProperty("chat") CHAT,
        @JsonProperty("status") STATUS,
        @JsonProperty("error") ERROR,
        @JsonProperty("personal") PERSONAL
    }

    public record Ref(String objectId, String name) {
    }
}
