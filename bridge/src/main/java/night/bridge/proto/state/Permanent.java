package night.bridge.proto.state;

import java.util.List;

/**
 * Protocol §6 {@code Permanent extends Card} — records can't inherit, so the
 * Card fields are repeated; the wire shape is flat either way. Field order
 * mirrors the spec: Card fields first, then the battlefield-only ones.
 */
public record Permanent(
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
        String controllerId,
        boolean tapped,
        Boolean flipped,
        Boolean transformed,
        String morph,
        Integer damage,
        Boolean summoningSick,
        List<String> attachments,
        String attachedTo,
        Boolean copy,
        Boolean commander) {
}
