package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Player chat into the game (protocol §10). The bridge relays into XMage's
 * game chat and acks; the line returns to every seat as a {@code game.log}
 * with {@code kind:'chat'} — the sender renders the echo, never a local copy.
 */
public record ChatSend(
        @JsonProperty(required = true) String id,
        @JsonProperty(required = true) String gameId,
        @JsonProperty(required = true) String text) implements ClientMsg {

    /** Max text length after trimming (protocol §10). */
    public static final int MAX_LENGTH = 500;
}
