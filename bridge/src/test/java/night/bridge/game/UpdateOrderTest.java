package night.bridge.game;

import mage.interfaces.callback.ClientCallback;
import mage.interfaces.callback.ClientCallbackMethod;
import org.junit.jupiter.api.Test;

import static mage.interfaces.callback.ClientCallbackMethod.CHATMESSAGE;
import static mage.interfaces.callback.ClientCallbackMethod.GAME_INFORM_PERSONAL;
import static mage.interfaces.callback.ClientCallbackMethod.GAME_OVER;
import static mage.interfaces.callback.ClientCallbackMethod.GAME_SELECT;
import static mage.interfaces.callback.ClientCallbackMethod.GAME_UPDATE;
import static mage.interfaces.callback.ClientCallbackMethod.GAME_UPDATE_AND_INFORM;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class UpdateOrderTest {

    private static ClientCallback cb(ClientCallbackMethod method, int messageId) {
        ClientCallback cb = new ClientCallback(method, null, null, false);
        cb.setMessageId(messageId);
        return cb;
    }

    /** In-order traffic passes untouched — the normal, un-backed-up case. */
    @Test
    void inOrderCallbacksAllPass() {
        UpdateOrder order = new UpdateOrder();
        assertTrue(order.admit(cb(GAME_UPDATE, 1)));
        assertTrue(order.admit(cb(CHATMESSAGE, 2)));
        assertTrue(order.admit(cb(GAME_SELECT, 3)));
        assertTrue(order.admit(cb(GAME_UPDATE_AND_INFORM, 4)));
        assertEquals(0, order.dropped());
    }

    /** The 1.4.63 backlog shape: a dialog jumps the lane, the older update trails it. */
    @Test
    void updateBehindADialogIsDropped() {
        UpdateOrder order = new UpdateOrder();
        assertTrue(order.admit(cb(GAME_SELECT, 7)));
        assertFalse(order.admit(cb(GAME_UPDATE, 5)));
        assertFalse(order.admit(cb(GAME_UPDATE_AND_INFORM, 6)));
        assertTrue(order.admit(cb(GAME_UPDATE, 8)));
        assertEquals(2, order.dropped());
    }

    /** GAME_OVER's view is final; a trailing update must not roll it back. */
    @Test
    void updateBehindGameOverIsDropped() {
        UpdateOrder order = new UpdateOrder();
        assertTrue(order.admit(cb(GAME_OVER, 20)));
        assertFalse(order.admit(cb(GAME_UPDATE, 19)));
    }

    /** Prompts and messages are never skipped, however late — only their state can be. */
    @Test
    void dialogsAndMessagesAlwaysPass() {
        UpdateOrder order = new UpdateOrder();
        assertTrue(order.admit(cb(GAME_UPDATE, 10)));
        assertTrue(order.admit(cb(GAME_SELECT, 9)));
        assertTrue(order.admit(cb(CHATMESSAGE, 3)));
        ClientCallback personal = cb(GAME_INFORM_PERSONAL, 4);
        assertTrue(order.admit(personal));
        assertTrue(order.behind(personal), "its embedded view is older than applied state");
    }

    /** Messages don't advance the mark: a chat line can't make the next update look stale. */
    @Test
    void messagesDoNotMoveTheMark() {
        UpdateOrder order = new UpdateOrder();
        assertTrue(order.admit(cb(GAME_UPDATE, 1)));
        assertTrue(order.admit(cb(CHATMESSAGE, 5)));
        assertTrue(order.admit(cb(GAME_UPDATE, 3)));
    }

    /** A recovered seat's new XMage session numbers callbacks from 1 again. */
    @Test
    void resetAcceptsANewSessionsNumbering() {
        UpdateOrder order = new UpdateOrder();
        assertTrue(order.admit(cb(GAME_UPDATE, 500)));
        order.reset();
        assertTrue(order.admit(cb(GAME_UPDATE, 1)));
    }
}
