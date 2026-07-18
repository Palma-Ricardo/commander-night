package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Client request for a fresh keyframe (protocol §7): sent when a patch's
 * {@code base} doesn't match the client's last applied seq, or any time the
 * client wants to re-anchor. Answered with an ack, then a keyframe event.
 */
public record GameResync(
        @JsonProperty(required = true) String id,
        @JsonProperty(required = true) String gameId) implements ClientMsg {
}
