package night.bridge.game;

import mage.interfaces.callback.ClientCallback;
import mage.interfaces.callback.ClientCallbackType;

/**
 * Stale-update gate for one XMage session (protocol §15, {@code GAME_UPDATE} row).
 *
 * <p>1.4.60 dropped a callback outright when the seat's send lock was busy. 1.4.63
 * queues it instead ({@code mage.interfaces.callback.ClientCallbacksQueue}), in two
 * FIFO lanes: dialogs and table changes go first, then updates and messages, and
 * a newer update replaces older queued ones of the same kind. So when the queue
 * backs up, an update can arrive <em>after</em> a dialog or {@code GAME_OVER} that
 * carries a newer GameView. Applying it would roll the table back to older state.
 *
 * <p>This mirrors XMage's own client ({@code CallbackClientImpl}). Every callback
 * carries its session's monotonic {@code messageId}. An {@code UPDATE}-type
 * callback older than the newest GameView already applied is ignored. Dialogs and
 * table changes are always processed, because a prompt can't be skipped. Messages
 * (chat, errors) are always processed and don't move the mark.
 *
 * <p>{@code messageId}s restart at 1 on a new XMage session, so seat recovery
 * must {@link #reset}. Pump-thread confined.
 */
final class UpdateOrder {

    private int newest;
    private int dropped;

    /** False when {@code cb} is an update older than state already applied: skip it whole. */
    boolean admit(ClientCallback cb) {
        ClientCallbackType type = cb.getMethod().getType();
        int id = cb.getMessageId();
        switch (type) {
            case UPDATE -> {
                if (id < newest) {
                    dropped++;
                    return false;
                }
                newest = id;
            }
            case TABLE_CHANGE, DIALOG -> newest = Math.max(newest, id);
            default -> {
                // MESSAGE, CLIENT_SIDE_EVENT: no state ordering to enforce
            }
        }
        return true;
    }

    /**
     * Whether a message-type callback's embedded GameView ({@code
     * GAME_INFORM_PERSONAL}) is behind applied state. Its text is still relayed.
     */
    boolean behind(ClientCallback cb) {
        return cb.getMessageId() < newest;
    }

    /** A new XMage session numbers its callbacks from 1 again. */
    void reset() {
        newest = 0;
    }

    /** Stale updates skipped so far, for the game-over log line. */
    int dropped() {
        return dropped;
    }
}
