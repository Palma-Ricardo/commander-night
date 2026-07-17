package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Ready toggle (protocol §5). */
public record LobbyReady(
        @JsonProperty(required = true) String id,
        @JsonProperty(required = true) boolean ready) implements ClientMsg {
}
