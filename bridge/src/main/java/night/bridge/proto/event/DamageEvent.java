package night.bridge.proto.event;

/**
 * Protocol §7.1 {@code damage} — {@code amount} dealt to {@code targetId} (a
 * permanent's marked damage, or a player's life loss). {@code combat} is true
 * when the loss lands in a combat-damage step. {@code cause} names the source
 * when the log gives it (NON_NULL). A player hit also carries a {@link LifeEvent}
 * for the running total; {@code damage} is the impact (flash / number / shake).
 */
public record DamageEvent(String targetId, int amount, boolean combat, Cause cause) implements GameEvent {

    public DamageEvent(String targetId, int amount, boolean combat) {
        this(targetId, amount, combat, null);
    }
}
