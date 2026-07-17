package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Join a lobby by code (protocol §5). Valid on a running game too: a
 * displayName matching a seated player re-binds that seat to the caller's
 * token — the lost-token recovery path (§16.6, M4).
 */
public record LobbyJoin(
        @JsonProperty(required = true) String id,
        @JsonProperty(required = true) String code,
        @JsonProperty(required = true) String displayName) implements ClientMsg {
}
