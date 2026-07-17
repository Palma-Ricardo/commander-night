package night.bridge.proto.state;

import java.util.List;

/**
 * Protocol §6 {@code Card} — the ~20 semantic fields that survive the trim
 * of XMage's ~70-field CardView. {@code set}+{@code number} is the client's
 * image lookup key. Optional fields are boxed and null when absent (the
 * shared mapper omits nulls).
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
        Boolean faceDown) {
}
