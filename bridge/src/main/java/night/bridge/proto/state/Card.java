package night.bridge.proto.state;

import java.util.List;

/**
 * Protocol §6 {@code Card} — the ~20 semantic fields that survive the trim
 * of XMage's ~70-field CardView. {@code set}+{@code number} is the client's
 * image lookup key. Optional fields are boxed and null when absent (the
 * shared mapper omits nulls).
 *
 * <p>Tokens are the exception: XMage ships them with an empty {@code number},
 * so {@code set}+{@code name} is all the client would otherwise have and two
 * distinct token arts sharing a name collide. {@code imageNumber} carries
 * XMage's own per-token-class art index for those — see the field.
 */
public record Card(
        String id,
        String name,
        String set,
        String number,
        String manaCost,
        int manaValue,
        List<String> types,
        List<String> subtypes,
        List<String> supertypes,
        List<Color> colors,
        List<String> text,
        String power,
        String toughness,
        String loyalty,
        String defense,
        List<Counter> counters,
        Boolean token,
        /**
         * Tokens only (null otherwise): XMage's {@code TokenInfo.imageNumber},
         * which distinguishes different arts sharing one set+name — a 1/1 white
         * Spirit from a 2/2 red Spirit. NOT a Scryfall collector number; it is
         * an identity/cache key, never a URL component. Preferred over power and
         * toughness for that job, since a token's wire P/T is its current value
         * and anthems change it while the art stays put.
         */
        Integer imageNumber,
        Boolean faceDown) {
}
