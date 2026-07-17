package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * First message on every connection (protocol §4). {@code token} is absent on
 * first contact; {@code resume} asks to rejoin a running game (§14).
 * {@code stateMode:'keyframes'} is the §7 debug escape hatch — carried here,
 * honored from M2 when game state exists.
 */
public record Hello(
        @JsonProperty(required = true) String id,
        @JsonProperty(required = true) int v,
        String token,
        Resume resume,
        String stateMode) implements ClientMsg {

    public record Resume(
            @JsonProperty(required = true) String gameId,
            @JsonProperty(required = true) long lastSeq) {
    }
}
