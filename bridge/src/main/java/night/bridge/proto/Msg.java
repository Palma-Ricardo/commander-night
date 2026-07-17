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
        @JsonSubTypes.Type(value = Hello.class, name = "session.hello"),
        @JsonSubTypes.Type(value = Welcome.class, name = "session.welcome"),
        @JsonSubTypes.Type(value = Ack.class, name = "ack"),
        @JsonSubTypes.Type(value = Err.class, name = "error"),
})
public sealed interface Msg permits ClientMsg, ServerMsg {
}
