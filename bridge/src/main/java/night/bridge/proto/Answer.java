package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

import java.util.List;

/**
 * The answer union inside game.answer (protocol §8), discriminated by
 * {@code type}. All nine shapes are defined; which ones a given prompt kind
 * accepts is the PromptFsm's validation job ({@code INVALID_ANSWER}).
 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
@JsonSubTypes({
        @JsonSubTypes.Type(value = Answer.Confirm.class, name = "confirm"),
        @JsonSubTypes.Type(value = Answer.Pick.class, name = "object"),
        @JsonSubTypes.Type(value = Answer.Picks.class, name = "objects"),
        @JsonSubTypes.Type(value = Answer.Amount.class, name = "number"),
        @JsonSubTypes.Type(value = Answer.Option.class, name = "option"),
        @JsonSubTypes.Type(value = Answer.Pile.class, name = "pile"),
        @JsonSubTypes.Type(value = Answer.Mana.class, name = "mana"),
        @JsonSubTypes.Type(value = Answer.Distribution.class, name = "distribution"),
        @JsonSubTypes.Type(value = Answer.Cancel.class, name = "cancel"),
})
public sealed interface Answer {

    /** Yes/no; also priority pass = {confirm,false}. */
    record Confirm(@JsonProperty(required = true) boolean value) implements Answer {
    }

    /** Act on / target / mana source / ability id. */
    record Pick(@JsonProperty(required = true) String objectId) implements Answer {
    }

    /** Multi-target submitted whole; the bridge replays one UUID at a time (M3). */
    record Picks(@JsonProperty(required = true) List<String> objectIds) implements Answer {
    }

    /** X announcements and other number picks. */
    record Amount(@JsonProperty(required = true) long value) implements Answer {
    }

    /** One string option by key. */
    record Option(@JsonProperty(required = true) String key) implements Answer {
    }

    /** Fact-or-Fiction style: pile 0 or 1. */
    record Pile(@JsonProperty(required = true) int index) implements Answer {
    }

    /** Pay from the mana pool: W/U/B/R/G or C. */
    record Mana(@JsonProperty(required = true) String color) implements Answer {
    }

    /** Split a total across targets (M3: distribute prompts). */
    record Distribution(@JsonProperty(required = true) List<Share> amounts) implements Answer {

        public record Share(
                @JsonProperty(required = true) String id,
                @JsonProperty(required = true) long amount) {
        }
    }

    /** Decline / cancel the pending prompt where allowed. */
    record Cancel() implements Answer {
    }
}
