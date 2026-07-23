package night.bridge.proto.event;

/**
 * Protocol §7.1 {@code trigger} — an ability from {@code sourceId} went on the
 * stack (triggered or activated). {@code stackId} is the ephemeral stack id it
 * took, when one exists (mana abilities never touch the stack). The client
 * spawns an ephemeral ghost of the source toward the stack rather than moving
 * the real permanent — the same permanent can put several abilities on the stack
 * (design §9, table-t4-direction note).
 */
public record TriggerEvent(String sourceId, String stackId) implements GameEvent {
}
