package night.bridge.proto;

/** A server → client message: a reply ({@code re}) or an event ({@code seq}). */
public sealed interface ServerMsg extends Msg
        permits Welcome, Ack, Err, LobbyState, StateKeyframe, GamePrompt, PromptDone, LogEntry, GameOver {
}
