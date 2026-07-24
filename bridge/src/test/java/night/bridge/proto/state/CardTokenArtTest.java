package night.bridge.proto.state;

import com.fasterxml.jackson.databind.JsonNode;
import night.bridge.proto.Json;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Protocol §6 {@code Card.imageNumber}: tokens carry XMage's art index so the
 * client can tell two same-named token arts apart (a 1/1 white Spirit from a
 * 2/2 red Spirit — live, 2026-07-20). No golden fixture contains a token, so
 * the wire shape is pinned here instead.
 */
class CardTokenArtTest {

    private static Card card(Boolean token, Integer imageNumber) {
        return new Card("c1", "Spirit", "NEC", token == Boolean.TRUE ? "" : "42",
                null, 0, List.of("CREATURE"), List.of("Spirit"), List.of(),
                List.of(Color.W), List.of(), "1", "1", null, null, null,
                token, imageNumber, null, null);
    }

    @Test
    void tokenCarriesItsArtIndex() {
        JsonNode n = Json.tree(card(true, 3));
        assertTrue(n.has("imageNumber"));
        assertEquals(3, n.get("imageNumber").asInt());
        assertTrue(n.get("token").asBoolean());
    }

    @Test
    void nonTokensOmitItEntirely() {
        JsonNode n = Json.tree(card(null, null));
        assertFalse(n.has("imageNumber"), "nulls are omitted — real cards key off set+number");
        assertFalse(n.has("token"));
    }

    @Test
    void artIndexZeroIsAValueNotAnAbsence() {
        // XMage's default imageNumber is 0; it must survive as 0, not vanish,
        // or every default-art token would fall back to the P/T cache key.
        JsonNode n = Json.tree(card(true, 0));
        assertTrue(n.has("imageNumber"));
        assertEquals(0, n.get("imageNumber").asInt());
    }
}
