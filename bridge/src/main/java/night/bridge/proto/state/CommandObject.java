package night.bridge.proto.state;

import java.util.List;

/**
 * Protocol §6 {@code CommandObject extends Card}: command-zone residents.
 * {@code castCount} is commander-only (tax = 2 × castCount).
 */
public record CommandObject(
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
        Boolean faceDown,
        Kind kind,
        Integer castCount) {

    public enum Kind {
        COMMANDER, EMBLEM, PLANE, DUNGEON;

        @com.fasterxml.jackson.annotation.JsonValue
        public String wire() {
            return name().toLowerCase(java.util.Locale.ROOT);
        }
    }
}
