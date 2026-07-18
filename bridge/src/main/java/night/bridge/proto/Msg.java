package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

/**
 * Protocol v1 message vocabulary — mirrors docs/protocol/v1.md, which is
 * normative for every shape here. The {@code t} field is the discriminator
 * (protocol §3); the sub-interfaces split the vocabulary by direction so the
 * codec can refuse server→client types arriving from a browser.
 *
 * <p>The {@code permits} clauses and this subtype table must list the same
 * classes; {@code CodecTest#everyMessageTypeHasAWireName} enforces it.
 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "t")
@JsonSubTypes({
        // session
        @JsonSubTypes.Type(value = Hello.class, name = "session.hello"),
        @JsonSubTypes.Type(value = Welcome.class, name = "session.welcome"),
        @JsonSubTypes.Type(value = Ack.class, name = "ack"),
        @JsonSubTypes.Type(value = Err.class, name = "error"),
        // lobby
        @JsonSubTypes.Type(value = LobbyCreate.class, name = "lobby.create"),
        @JsonSubTypes.Type(value = LobbyJoin.class, name = "lobby.join"),
        @JsonSubTypes.Type(value = LobbyDeck.class, name = "lobby.deck"),
        @JsonSubTypes.Type(value = LobbyReady.class, name = "lobby.ready"),
        @JsonSubTypes.Type(value = LobbyStart.class, name = "lobby.start"),
        @JsonSubTypes.Type(value = LobbyState.class, name = "lobby.state"),
        // game
        @JsonSubTypes.Type(value = GameAnswer.class, name = "game.answer"),
        @JsonSubTypes.Type(value = GameAction.class, name = "game.action"),
        @JsonSubTypes.Type(value = GameResync.class, name = "game.resync"),
        @JsonSubTypes.Type(value = StateKeyframe.class, name = "game.state"),
        @JsonSubTypes.Type(value = StatePatch.class, name = "game.patch"),
        @JsonSubTypes.Type(value = GamePrompt.class, name = "game.prompt"),
        @JsonSubTypes.Type(value = PromptDone.class, name = "game.promptDone"),
        @JsonSubTypes.Type(value = LogEntry.class, name = "game.log"),
        @JsonSubTypes.Type(value = GameOver.class, name = "game.over"),
        // chat
        @JsonSubTypes.Type(value = ChatSend.class, name = "chat.send"),
})
public sealed interface Msg permits ClientMsg, ServerMsg {
}
