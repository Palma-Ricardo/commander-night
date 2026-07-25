package night.bridge.golden;

import mage.interfaces.callback.ClientCallback;
import mage.util.MultiAmountMessage;
import mage.view.GameClientMessage;
import mage.view.GameView;
import mage.view.PermanentView;
import mage.view.PlayerView;
import night.bridge.proto.GamePrompt;
import night.bridge.translate.PromptTranslator;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.Serializable;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * {@code distribute.among[].objectId} (protocol §8, M7) — the name-match
 * fallback, against a real captured board. {@code GAME_GET_MULTI_AMOUNT} has
 * never fired live (§16.1), so the rows here are synthesized in XMage's 1.4.60
 * shapes while the {@link GameView} they resolve against is a genuine
 * {@link night.bridge.xmage.CallbackTap} capture — which conveniently carries
 * both a unique permanent (Snapcaster Mage) and a triplicated one (Sensei's
 * Divining Top, one on three different battlefields).
 *
 * <p>The exact-link path (the row's own {@code object_id}) needs no board and is
 * covered in {@code PromptTranslatorTest}.
 */
class DistributeAnchorTest {

    private static GameView board;

    @BeforeAll
    static void loadBoard() throws Exception {
        ClientCallback cb = GoldenFixtures.readFixture(
                GoldenFixtures.DIR.resolve(Path.of("game_update.big-board.ser")));
        cb.decompressData();
        board = (GameView) cb.getData();
    }

    private static GamePrompt distribute(String... labels) {
        List<MultiAmountMessage> rows = java.util.Arrays.stream(labels)
                .map(l -> new MultiAmountMessage(l, 0, 4, 0))
                .toList();
        Map<String, Serializable> options = new HashMap<>();
        options.put("header", "Assign combat damage");
        return PromptTranslator.distribute(1,
                new GameClientMessage(null, options, rows, 4, 4), board);
    }

    /** The id of the sole permanent with this name, asserting it really is sole. */
    private static String only(String name) {
        String found = null;
        for (PlayerView p : board.getPlayers()) {
            for (Map.Entry<UUID, PermanentView> e : p.getBattlefield().entrySet()) {
                if (name.equals(e.getValue().getName())) {
                    assertNull(found, name + " is not unique on this board");
                    found = e.getKey().toString();
                }
            }
        }
        assertNotNull(found, name + " is not on this board");
        return found;
    }

    @Test
    void aRowWithoutALinkFallsBackToAUniqueNameMatch() {
        GamePrompt p = distribute("Snapcaster Mage, P/T: 2/1");
        assertEquals(only("Snapcaster Mage"), p.among().getFirst().objectId());
    }

    @Test
    void twoSameNamedPermanentsOmitTheObjectId() {
        GamePrompt p = distribute("Sensei's Divining Top, P/T: 0/0");
        assertNull(p.among().getFirst().objectId(),
                "three Divining Tops on the board — an anchor here would be a coin flip");
    }

    @Test
    void aNameThatIsOnNoBattlefieldOmitsTheObjectId() {
        GamePrompt p = distribute("Grizzly Bears, P/T: 2/2");
        assertNull(p.among().getFirst().objectId());
    }

    @Test
    void theLinkWinsOverTheNameWhenBothArePresent() {
        String top = "<font color='#B0C4DE' object_id='11111111-2222-3333-4444-555555555555'>"
                + "Sensei's Divining Top</font> [111], P/T: 0/0";
        GamePrompt p = distribute(top);
        assertEquals("11111111-2222-3333-4444-555555555555", p.among().getFirst().objectId(),
                "an exact link beats an ambiguous name");
    }
}
