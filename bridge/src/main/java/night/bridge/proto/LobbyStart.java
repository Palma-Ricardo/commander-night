package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Host starts the game (protocol §5). {@code fillAI:true} fills empty seats
 * with server AI (COMPUTER_MAD) playing sample decks (design §9).
 */
public record LobbyStart(
        @JsonProperty(required = true) String id,
        Boolean fillAI) implements ClientMsg {

    public boolean wantsAiFill() {
        return Boolean.TRUE.equals(fillAI);
    }
}
