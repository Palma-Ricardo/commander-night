package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Create a lobby (protocol §5). Acked with the join code. */
public record LobbyCreate(
        @JsonProperty(required = true) String id,
        @JsonProperty(required = true) String format,
        String name) implements ClientMsg {

    public static final String FORMAT_COMMANDER_FFA = "commander-ffa";
}
