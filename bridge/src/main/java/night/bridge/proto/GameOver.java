package night.bridge.proto;

import java.util.List;

/**
 * Game end (protocol §11), built from GAME_OVER + END_GAME_INFO. A final
 * keyframe always precedes this event ({@code finalState} asserts it).
 * The socket stays open for post-game chat and rematch.
 */
public record GameOver(
        long seq,
        String gameId,
        List<String> winnerPlayerIds,
        String reason,
        boolean finalState) implements ServerMsg {
}
