package night.bridge.net;

import com.fasterxml.jackson.core.JacksonException;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.InvalidTypeIdException;
import night.bridge.proto.ClientMsg;
import night.bridge.proto.Json;
import night.bridge.proto.Msg;
import night.bridge.proto.ServerMsg;

/**
 * Protocol v1 (de)serialization and the BAD_MESSAGE boundary (protocol §3):
 * unknown fields and unknown {@code t} values are ignored for forward
 * compatibility; everything else that fails to decode is a client error,
 * never an exception escaping to the socket layer.
 */
public final class Codec {

    /** Outcome of decoding one text frame. */
    public sealed interface Decoded {

        /** A well-formed client command. */
        record Ok(ClientMsg msg) implements Decoded {
        }

        /** Unknown {@code t} — dropped silently per §3, surfaced for logging. */
        record Ignored(String t) implements Decoded {
        }

        /** Maps to {@code error BAD_MESSAGE}; {@code re} is the command id when one was readable. */
        record Bad(String reason, String re) implements Decoded {
        }
    }

    private final ObjectMapper mapper = Json.MAPPER;

    public String encode(ServerMsg msg) {
        try {
            return mapper.writeValueAsString(msg);
        } catch (JsonProcessingException e) {
            // Our own types failed to serialize — a bridge bug, not a client problem.
            throw new IllegalStateException("unencodable server message: " + msg.getClass().getName(), e);
        }
    }

    public Decoded decode(String frame) {
        JsonNode root;
        try {
            root = mapper.readTree(frame);
        } catch (JacksonException e) {
            return new Decoded.Bad("malformed JSON", null);
        }
        if (root == null || !root.isObject()) {
            return new Decoded.Bad("frame is not a JSON object", null);
        }
        String re = root.path("id").isTextual() ? root.get("id").asText() : null;
        JsonNode t = root.get("t");
        if (t == null || !t.isTextual()) {
            return new Decoded.Bad("missing 't' discriminator", re);
        }
        Msg msg;
        try {
            msg = mapper.treeToValue(root, Msg.class);
        } catch (InvalidTypeIdException e) {
            return new Decoded.Ignored(t.asText());
        } catch (JacksonException e) {
            return new Decoded.Bad(e.getOriginalMessage(), re);
        }
        if (!(msg instanceof ClientMsg cmd)) {
            return new Decoded.Bad("'" + t.asText() + "' is not a client command", re);
        }
        return new Decoded.Ok(cmd);
    }
}
