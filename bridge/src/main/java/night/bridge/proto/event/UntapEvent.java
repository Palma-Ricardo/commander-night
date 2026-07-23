package night.bridge.proto.event;

/**
 * Protocol §7.1 {@code untap} — a permanent turned upright. Shares the shape of
 * {@link TapEvent} minus {@code forMana} (untapping never pays mana). The untap
 * step emits one per permanent that untapped, so the client can ripple the board.
 */
public record UntapEvent(String objectId) implements GameEvent {
}
