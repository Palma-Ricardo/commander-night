package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;

/**
 * The one Jackson configuration for protocol v1: unknown fields ignored
 * (§3 forward compatibility), absent optionals omitted from the wire
 * (NON_NULL). Codec (framing) and StateStore (keyframe trees) must agree on
 * these settings or their bytes drift — hence a single shared mapper.
 */
public final class Json {

    public static final ObjectMapper MAPPER = JsonMapper.builder()
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .serializationInclusion(JsonInclude.Include.NON_NULL)
            .build();

    /** Record → tree, for state equality checks and diffing (design §7). */
    public static JsonNode tree(Object value) {
        return MAPPER.valueToTree(value);
    }

    private Json() {
    }
}
