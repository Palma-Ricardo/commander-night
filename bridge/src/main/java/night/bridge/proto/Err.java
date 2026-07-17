package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Error reply/event (protocol §12). {@code re} is present when the error
 * answers a specific command. Non-fatal errors never close the socket;
 * {@code fatal:true} means the seat is unrecoverable on this connection.
 */
public record Err(
        String re,
        @JsonProperty(required = true) ErrorCode code,
        @JsonProperty(required = true) String message,
        Boolean fatal) implements ServerMsg {

    public static Err of(ErrorCode code, String message) {
        return new Err(null, code, message, null);
    }

    public static Err re(String re, ErrorCode code, String message) {
        return new Err(re, code, message, null);
    }

    public static Err fatal(String re, ErrorCode code, String message) {
        return new Err(re, code, message, true);
    }
}
