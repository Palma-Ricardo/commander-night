package night.bridge.proto.event;

/**
 * Protocol §7.1 {@code tap} — a permanent turned sideways. {@code forMana} is set
 * when the log shows the tap paid for mana (the client can spark a mana-coloured
 * pip toward the pool); absent otherwise (NON_NULL). The paired {@code untap} is
 * {@link UntapEvent}; the untap step emits one per permanent that untapped, which
 * the client can ripple.
 */
public record TapEvent(String objectId, Boolean forMana) implements GameEvent {

    public TapEvent(String objectId) {
        this(objectId, null);
    }
}
