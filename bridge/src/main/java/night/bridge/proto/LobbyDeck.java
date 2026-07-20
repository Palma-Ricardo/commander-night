package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Deck submission as text (protocol §5). Clients send {@code auto} and let the
 * bridge sniff between {@code dck} ({@code N [SET:NUM] Name}, SB: = commander),
 * {@code moxfield} ({@code N Name (SET) NUM}) and {@code mtgo} ({@code N Name});
 * the explicit values exist for tests and a manual override. Acked with the parse
 * result; problems and warnings are reported via the lobby.state deck info, which
 * also echoes the format the bridge concluded.
 */
public record LobbyDeck(
        @JsonProperty(required = true) String id,
        @JsonProperty(required = true) String format,
        @JsonProperty(required = true) String content) implements ClientMsg {

    public static final String FORMAT_AUTO = "auto";
    public static final String FORMAT_DCK = "dck";
    public static final String FORMAT_MOXFIELD = "moxfield";
    public static final String FORMAT_MTGO = "mtgo";
}
