package night.bridge.sync;

import com.fasterxml.jackson.databind.JsonNode;
import com.flipkart.zjsonpatch.DiffFlags;
import com.flipkart.zjsonpatch.JsonDiff;

import java.util.EnumSet;

/**
 * RFC 6902 diff between trimmed state trees (design §1): add/remove/replace
 * only — MOVE and COPY are disabled so the ops stay trivially compatible with
 * the client's fast-json-patch and zone-change animation heuristics
 * (protocol §7); OMIT_VALUE_ON_REMOVE keeps remove ops RFC-shaped.
 */
final class Differ {

    private static final EnumSet<DiffFlags> FLAGS = EnumSet.of(
            DiffFlags.OMIT_VALUE_ON_REMOVE,
            DiffFlags.OMIT_MOVE_OPERATION,
            DiffFlags.OMIT_COPY_OPERATION);

    static JsonNode diff(JsonNode from, JsonNode to) {
        return JsonDiff.asJson(from, to, FLAGS);
    }

    private Differ() {
    }
}
