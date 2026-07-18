package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

/**
 * A player-initiated action that needs no pending prompt (protocol §9):
 * concede, priority skips, rollback request, mana auto-payment toggle,
 * trigger-order reset. Maps onto XMage's {@code sendPlayerAction} channel
 * (protocol §15); runs on the seat pump so it serializes with answers.
 */
public record GameAction(
        @JsonProperty(required = true) String id,
        @JsonProperty(required = true) String gameId,
        @JsonProperty(required = true) Action action) implements ClientMsg {

    @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "kind")
    @JsonSubTypes({
            @JsonSubTypes.Type(value = Action.Concede.class, name = "concede"),
            @JsonSubTypes.Type(value = Action.Skip.class, name = "skip"),
            @JsonSubTypes.Type(value = Action.RequestRollback.class, name = "requestRollback"),
            @JsonSubTypes.Type(value = Action.AutoMana.class, name = "autoMana"),
            @JsonSubTypes.Type(value = Action.TriggerOrder.class, name = "triggerOrder"),
    })
    public sealed interface Action {

        record Concede() implements Action {
        }

        /** Skip priority until…; {@code cancel} clears all active skips. */
        record Skip(@JsonProperty(required = true) Mode mode) implements Action {

            public enum Mode {
                @JsonProperty("stack") STACK,
                @JsonProperty("endOfTurn") END_OF_TURN,
                @JsonProperty("nextMain") NEXT_MAIN,
                @JsonProperty("myNextTurn") MY_NEXT_TURN,
                @JsonProperty("endStepBeforeMyTurn") END_STEP_BEFORE_MY_TURN,
                @JsonProperty("cancel") CANCEL
            }
        }

        /** {@code turns:0} = to the start of the current turn (XMage semantics). */
        record RequestRollback(@JsonProperty(required = true) int turns) implements Action {
        }

        record AutoMana(@JsonProperty(required = true) boolean enabled) implements Action {
        }

        record TriggerOrder(@JsonProperty(required = true) Mode mode) implements Action {

            public enum Mode {
                @JsonProperty("reset") RESET
            }
        }
    }
}
