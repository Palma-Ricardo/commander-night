package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Session role (protocol §4). Spectators are reserved for v2 (§16.7). */
public enum Role {
    @JsonProperty("player")
    PLAYER,
    @JsonProperty("spectator")
    SPECTATOR
}
