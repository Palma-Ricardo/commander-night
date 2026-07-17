package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Positive reply to a command, referencing its {@code id} (protocol §3). */
public record Ack(
        @JsonProperty(required = true) String re) implements ServerMsg {
}
