package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Host starts the game (protocol §5). {@code fillAI:true} fills empty seats
 * with bridge-hosted AI (an in-JVM Brain answering a HUMAN seat) playing the
 * configured AI decks (design §9).
 */
public record LobbyStart(
        @JsonProperty(required = true) String id,
        Boolean fillAI) implements ClientMsg {

    public boolean wantsAiFill() {
        return Boolean.TRUE.equals(fillAI);
    }
}
