package night.bridge.golden;

import mage.view.CardView;
import mage.view.CardsView;
import mage.view.GameClientMessage;
import mage.view.GameView;
import night.bridge.proto.state.GameState;
import night.bridge.translate.ViewTranslator;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

/**
 * Protocol §6 pins {@code state.stack} as <b>bottom → top</b>, but XMage hands us
 * the opposite order and no captured fixture has ever had more than one item on
 * the stack, so nothing caught the mismatch until a live game showed the client's
 * "next:" marker sitting on the bottom item.
 *
 * <p>XMage's {@code SpellStack extends ArrayDeque<StackObject>} and every push
 * site calls {@code push} — i.e. {@code addFirst} — while {@code resolve()} takes
 * {@code peek()}, the head. So the head is the <b>top</b> of the stack and
 * {@code GameView.getStack()} iterates top → bottom. {@link ViewTranslator} must
 * reverse that to satisfy the documented contract.
 *
 * <p>Live captures only ever produced single-item stacks, so the second item here
 * is synthesised: {@code CardsView} is a {@code LinkedHashMap}, so putting a new
 * key appends it to the tail — which in XMage's ordering is the bottom of the
 * stack. Real {@link CardView} data comes from the fixture.
 */
class StackOrderTest {

    @Test
    void stackIsEmittedBottomToTopNotInXmageTopFirstOrder() throws Exception {
        var cb = GoldenFixtures.readFixture(GoldenFixtures.DIR.resolve(Path.of("game_select.ser")));
        cb.decompressData();
        GameView view = ((GameClientMessage) cb.getData()).getGameView();

        CardsView stack = view.getStack();
        assertEquals(1, stack.size(), "fixture game_select.ser should have a one-item stack");

        // The fixture's only entry is, by definition, the top of the stack.
        Map.Entry<UUID, CardView> top = stack.entrySet().iterator().next();
        UUID topId = top.getKey();

        // Append a second entry: LinkedHashMap puts it at the tail, and XMage's
        // tail is the bottom of the stack (head == top == resolves next).
        UUID bottomId = new UUID(0xB0770, 0xB0770);
        assertNotEquals(topId, bottomId);
        stack.put(bottomId, top.getValue());

        GameState state = ViewTranslator.translate(view, GoldenFixtures.GAME_ID, GoldenFixtures.MY_PLAYER);

        List<String> emitted = state.stack().stream().map(i -> i.id()).toList();
        assertEquals(List.of(bottomId.toString(), topId.toString()), emitted,
                "protocol §6 declares state.stack as bottom → top, so the item that "
                        + "resolves next (XMage's head) must be LAST in the array");
    }
}
