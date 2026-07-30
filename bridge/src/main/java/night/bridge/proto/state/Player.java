package night.bridge.proto.state;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * Protocol §6 {@code Player}: one seat's public view. Zones are ordered
 * arrays (order is meaningful in MTG); hidden zones appear only as counts.
 */
public record Player(
        String id,
        String name,
        boolean human,
        int life,
        List<Counter> counters,
        ManaPool manaPool,
        int librarySize,
        int handSize,
        List<Permanent> battlefield,
        List<Card> graveyard,
        List<Card> exile,
        List<CommandObject> commandZone,
        List<CommanderDamage> commanderDamage,
        Flags flags,
        Timer timer,
        // Top of library while an effect keeps it revealed (Future Sight-class);
        // PlayerView.topCard, non-null only while isTopCardRevealed (§6, 2026-07-29).
        Card topCard) {

    public record ManaPool(
            @JsonProperty("W") int w,
            @JsonProperty("U") int u,
            @JsonProperty("B") int b,
            @JsonProperty("R") int r,
            @JsonProperty("G") int g,
            @JsonProperty("C") int c) {
    }

    public record CommanderDamage(String fromCommanderId, int amount) {
    }

    /** All-optional flag block; a Flags with every field null is omitted entirely. */
    public record Flags(Boolean monarch, Boolean initiative, Boolean left, Boolean dead) {
    }

    /** Absent in v1 — tables are untimed (design §1); kept for shape parity with the spec. */
    public record Timer(int remainingSecs, boolean active) {
    }
}
