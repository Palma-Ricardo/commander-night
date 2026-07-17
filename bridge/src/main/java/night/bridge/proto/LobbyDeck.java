package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Deck submission as text (protocol §5): {@code dck} ([SET:NUM] Name lines,
 * SB: = commander) or {@code list} ("1 Card Name" lines). Acked with the
 * parse result; problems are reported per line via the lobby.state deck info.
 */
public record LobbyDeck(
        @JsonProperty(required = true) String id,
        @JsonProperty(required = true) String format,
        @JsonProperty(required = true) String content) implements ClientMsg {

    public static final String FORMAT_DCK = "dck";
    public static final String FORMAT_LIST = "list";
}
