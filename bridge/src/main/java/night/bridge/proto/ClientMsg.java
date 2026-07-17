package night.bridge.proto;

/**
 * A command: client → server, carries a client-generated {@code id} that the
 * reply ({@code ack} or {@code error}) echoes as {@code re} (protocol §3).
 */
public sealed interface ClientMsg extends Msg
        permits Hello, LobbyCreate, LobbyJoin, LobbyDeck, LobbyReady, LobbyStart, GameAnswer {

    String id();
}
