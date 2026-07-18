package night.bridge.proto.state;

import com.fasterxml.jackson.annotation.JsonValue;

import java.util.List;
import java.util.Locale;

/**
 * Protocol §6 {@code GameState} — the document keyframes carry and patches
 * mutate. This is the bridge's canonical trimmed model; ViewTranslator is the
 * only writer.
 */
public record GameState(
        String gameId,
        Status status,
        boolean rollbackTurnsAllowed,
        Turn turn,
        List<Player> players,
        List<StackItem> stack,
        List<CombatGroup> combat,
        List<NamedCards> revealed,
        List<NamedCards> lookedAt,
        Me me) {

    public enum Status {
        ACTIVE, OVER;

        @JsonValue
        public String wire() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    public record Turn(
            int n,
            Phase phase,
            Step step,
            String activePlayerId,
            String priorityPlayerId) {
    }

    /** The private zone; omitted for spectators (v2). */
    public record Me(String playerId, List<Card> hand, Skip skip) {

        /**
         * The active §9 skip (absent = none). At most one is ever active —
         * 1.4.60 PlayerImpl resets every skip flag before setting any.
         */
        public enum Skip {
            STACK("stack"),
            END_OF_TURN("endOfTurn"),
            NEXT_MAIN("nextMain"),
            MY_NEXT_TURN("myNextTurn"),
            END_STEP_BEFORE_MY_TURN("endStepBeforeMyTurn");

            private final String wire;

            Skip(String wire) {
                this.wire = wire;
            }

            @JsonValue
            public String wire() {
                return wire;
            }
        }
    }

    /** The same snapshot with status flipped — the final keyframe before game.over (protocol §11). */
    public GameState over() {
        return new GameState(gameId, Status.OVER, rollbackTurnsAllowed, turn, players, stack, combat,
                revealed, lookedAt, me);
    }
}
