package night.bridge.golden;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import mage.interfaces.callback.ClientCallback;
import mage.view.AbilityPickerView;
import mage.view.GameClientMessage;
import mage.view.GameView;
import mage.view.UserRequestMessage;
import night.bridge.net.Codec;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.Json;
import night.bridge.proto.ServerMsg;
import night.bridge.proto.StateKeyframe;
import night.bridge.translate.PromptTranslator;
import night.bridge.translate.ViewTranslator;

import java.io.EOFException;
import java.io.IOException;
import java.io.ObjectInputStream;
import java.io.ObjectStreamException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;

/**
 * Golden-fixture plumbing (design §13). A fixture is one Java-serialized
 * {@link ClientCallback}, captured pre-decompression by {@link
 * night.bridge.xmage.CallbackTap} during a live game and selected by {@link
 * FixtureSelectMain}. {@link #route} replays it through the same translator
 * calls {@code SeatPump.handle} makes and returns the would-be wire messages
 * in emit order — state first, then prompt (protocol §7) — with pinned
 * {@code seq} 0/1, {@code promptId} 1, {@code gameId "g"}.
 *
 * <p>{@code myPlayerId} is pinned to the zero UUID so keyframes exercise the
 * {@code me}/hand trim path; the priority translator's seat-player id is null
 * (unknowable from a captured callback), so combat {@code declared} lists in
 * goldens are empty — the live tier covers those.
 */
final class GoldenFixtures {

    static final Path DIR = Path.of("src", "test", "resources", "fixtures");
    static final String GAME_ID = "g";
    static final UUID MY_PLAYER = new UUID(0, 0);

    private static final Codec CODEC = new Codec();
    private static final ObjectMapper JSON = new ObjectMapper();

    static void readTap(Path serFile, Consumer<ClientCallback> each) throws IOException, ClassNotFoundException {
        try (ObjectInputStream in = new ObjectInputStream(Files.newInputStream(serFile))) {
            while (true) {
                ClientCallback cb;
                try {
                    cb = (ClientCallback) in.readObject();
                } catch (EOFException | ObjectStreamException eof) {
                    return;     // truncated tail (bridge killed mid-write) ends the stream too
                }
                each.accept(cb);
            }
        }
    }

    static ClientCallback readFixture(Path serFile) throws IOException, ClassNotFoundException {
        try (ObjectInputStream in = new ObjectInputStream(Files.newInputStream(serFile))) {
            return (ClientCallback) in.readObject();
        }
    }

    /** The callback's would-be wire output as a JSON array (may be empty for untranslated kinds). */
    static ArrayNode route(ClientCallback cb) {
        cb.decompressData();
        List<ServerMsg> out = new ArrayList<>();
        Object data = cb.getData();
        switch (cb.getMethod()) {
            case GAME_INIT, GAME_UPDATE -> {
                if (data instanceof GameView view) {
                    out.add(keyframe(view));
                }
            }
            case GAME_UPDATE_AND_INFORM, GAME_INFORM_PERSONAL -> {
                GameClientMessage msg = (GameClientMessage) data;
                addKeyframe(out, msg.getGameView());
            }
            case GAME_ASK -> {
                GameClientMessage msg = (GameClientMessage) data;
                addKeyframe(out, msg.getGameView());
                out.add(emit(PromptTranslator.confirm(1, msg)));
            }
            case GAME_SELECT -> {
                GameClientMessage msg = (GameClientMessage) data;
                GameView view = msg.getGameView();
                addKeyframe(out, view);
                out.add(emit(PromptTranslator.priority(1, msg, view,
                        view == null ? null : ViewTranslator.translate(view, GAME_ID, MY_PLAYER), null)));
            }
            case GAME_TARGET -> {
                GameClientMessage msg = (GameClientMessage) data;
                addKeyframe(out, msg.getGameView());
                out.add(emit(PromptTranslator.chooseTargets(1, msg)));
            }
            case GAME_PLAY_MANA -> {
                GameClientMessage msg = (GameClientMessage) data;
                addKeyframe(out, msg.getGameView());
                out.add(emit(PromptTranslator.payMana(1, msg, msg.getGameView())));
            }
            case GAME_CHOOSE_ABILITY -> {
                AbilityPickerView picker = (AbilityPickerView) data;
                addKeyframe(out, picker.getGameView());
                out.add(emit(PromptTranslator.chooseAbility(1, picker)));
            }
            case GAME_CHOOSE_CHOICE -> {
                GameClientMessage msg = (GameClientMessage) data;
                addKeyframe(out, msg.getGameView());
                out.add(emit(PromptTranslator.chooseOption(1, msg)));
            }
            case GAME_CHOOSE_PILE -> {
                GameClientMessage msg = (GameClientMessage) data;
                addKeyframe(out, msg.getGameView());
                out.add(emit(PromptTranslator.choosePile(1, msg)));
            }
            case GAME_GET_AMOUNT -> {
                GameClientMessage msg = (GameClientMessage) data;
                addKeyframe(out, msg.getGameView());
                out.add(emit(PromptTranslator.chooseAmount(1, msg)));
            }
            case GAME_GET_MULTI_AMOUNT -> {
                GameClientMessage msg = (GameClientMessage) data;
                addKeyframe(out, msg.getGameView());
                out.add(emit(PromptTranslator.distribute(1, msg, msg.getGameView())));
            }
            case GAME_PLAY_XMANA -> {
                GameClientMessage msg = (GameClientMessage) data;
                addKeyframe(out, msg.getGameView());
                out.add(emit(PromptTranslator.confirm(1, msg)));
            }
            case USER_REQUEST_DIALOG -> {
                if (data instanceof UserRequestMessage msg) {
                    out.add(emit(PromptTranslator.playerRequest(1, msg)));
                }
            }
            default -> throw new IllegalArgumentException(
                    "no golden route for callback method " + cb.getMethod());
        }
        ArrayNode array = JSON.createArrayNode();
        for (ServerMsg msg : out) {
            array.add(tree(msg));
        }
        return array;
    }

    private static void addKeyframe(List<ServerMsg> out, GameView view) {
        if (view != null) {
            out.add(keyframe(view));
        }
    }

    private static ServerMsg keyframe(GameView view) {
        return new StateKeyframe(0, GAME_ID,
                Json.tree(ViewTranslator.translate(view, GAME_ID, MY_PLAYER)));
    }

    private static ServerMsg emit(GamePrompt prompt) {
        return prompt.emitted(1, GAME_ID);
    }

    private static JsonNode tree(ServerMsg msg) {
        try {
            return JSON.readTree(CODEC.encode(msg));
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    private GoldenFixtures() {
    }
}
