package night.bridge.net;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import night.bridge.proto.Ack;
import night.bridge.proto.Answer;
import night.bridge.proto.Err;
import night.bridge.proto.ErrorCode;
import night.bridge.proto.GameAnswer;
import night.bridge.proto.GameOver;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.Hello;
import night.bridge.proto.Json;
import night.bridge.proto.LobbyCreate;
import night.bridge.proto.LobbyDeck;
import night.bridge.proto.LobbyJoin;
import night.bridge.proto.LobbyReady;
import night.bridge.proto.LobbyStart;
import night.bridge.proto.LobbyState;
import night.bridge.proto.LogEntry;
import night.bridge.proto.PromptDone;
import night.bridge.proto.Role;
import night.bridge.proto.ServerMsg;
import night.bridge.proto.StateKeyframe;
import night.bridge.proto.Welcome;
import night.bridge.proto.state.Card;
import night.bridge.proto.state.Color;
import night.bridge.proto.state.CommandObject;
import night.bridge.proto.state.Counter;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.Permanent;
import night.bridge.proto.state.Phase;
import night.bridge.proto.state.Player;
import night.bridge.proto.state.StackItem;
import night.bridge.proto.state.Step;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Conformance corpus (design §13): the committed samples under
 * docs/protocol/samples/ are the agreement between this bridge and the future
 * TS client. Client → server samples must decode; server → client samples
 * must be exactly reproducible from our message types (tree equality — key
 * order is not significant).
 */
class ProtocolSamplesTest {

    // Surefire runs with cwd = bridge/; the corpus lives beside the spec.
    private static final Path SAMPLES = Path.of("..", "docs", "protocol", "samples");

    private final Codec codec = new Codec();
    private final ObjectMapper json = new ObjectMapper();

    private JsonNode sample(String name) throws Exception {
        Path file = SAMPLES.resolve(name);
        assertTrue(Files.exists(file), "missing corpus sample " + file.toAbsolutePath().normalize());
        return json.readTree(Files.readString(file));
    }

    private void assertProduces(String sampleName, ServerMsg msg) throws Exception {
        assertEquals(sample(sampleName), json.readTree(codec.encode(msg)), sampleName);
    }

    @Test
    void helloFreshDecodes() throws Exception {
        Codec.Decoded.Ok ok = assertInstanceOf(Codec.Decoded.Ok.class,
                codec.decode(sample("session.hello.fresh.json").toString()));
        assertEquals(new Hello("c1", 1, null, null, null), ok.msg());
    }

    @Test
    void helloResumeDecodes() throws Exception {
        Codec.Decoded.Ok ok = assertInstanceOf(Codec.Decoded.Ok.class,
                codec.decode(sample("session.hello.resume.json").toString()));
        Hello h = (Hello) ok.msg();
        assertEquals("kZ1xW3vJqL8mN5aPbT9cDg", h.token());
        assertEquals(new Hello.Resume("3f2a9d1e-6c47-4b2e-9a10-8e5d21f7b0c4", 812), h.resume());
    }

    @Test
    void welcomeSamplesAreReproducible() throws Exception {
        assertProduces("session.welcome.fresh.json",
                new Welcome("c1", 1, "7d4c1b2a-9e8f-4a3b-b6c5-0d1e2f3a4b5c",
                        "kZ1xW3vJqL8mN5aPbT9cDg", Role.PLAYER, false));
        assertProduces("session.welcome.resumed.json",
                new Welcome("c2", 1, "7d4c1b2a-9e8f-4a3b-b6c5-0d1e2f3a4b5c",
                        null, Role.PLAYER, true));
    }

    @Test
    void ackSampleIsReproducible() throws Exception {
        assertProduces("ack.json", new Ack("c3"));
    }

    @Test
    void errorSamplesAreReproducible() throws Exception {
        assertProduces("error.json",
                Err.re("c4", ErrorCode.BAD_MESSAGE, "missing 't' discriminator"));
        assertProduces("error.fatal.json",
                Err.fatal("c5", ErrorCode.UNSUPPORTED_VERSION,
                        "protocol v2 is not supported; this bridge speaks v1"));
    }

    // ---- M2: lobby ----

    private ClientMsgOf decoded(String sampleName) throws Exception {
        Codec.Decoded.Ok ok = assertInstanceOf(Codec.Decoded.Ok.class,
                codec.decode(sample(sampleName).toString()), sampleName);
        return new ClientMsgOf(ok.msg());
    }

    private record ClientMsgOf(Object msg) {
    }

    @Test
    void lobbyCommandSamplesDecode() throws Exception {
        assertEquals(new LobbyCreate("c10", "commander-ffa", "Tuesday Night"),
                decoded("lobby.create.json").msg());
        assertEquals(new LobbyJoin("c11", "XKCD42", "Ricardo"),
                decoded("lobby.join.json").msg());
        assertEquals(new LobbyDeck("c12", "dck",
                        "1 [C21:263] Command Tower\nSB: 1 [KHM:222] Lathril, Blade of the Elves"),
                decoded("lobby.deck.json").msg());
        assertEquals(new LobbyReady("c13", true), decoded("lobby.ready.json").msg());
        assertEquals(new LobbyStart("c14", true), decoded("lobby.start.json").msg());
    }

    @Test
    void lobbyStateSampleIsReproducible() throws Exception {
        assertProduces("lobby.state.json", new LobbyState(
                "XKCD42",
                "7d4c1b2a-9e8f-4a3b-b6c5-0d1e2f3a4b5c",
                List.of(new LobbyState.Seat(
                        "7d4c1b2a-9e8f-4a3b-b6c5-0d1e2f3a4b5c",
                        "Ricardo",
                        new LobbyState.DeckInfo(true, List.of("Lathril, Blade of the Elves"), 100, null),
                        true))));
    }

    // ---- M2: answers ----

    @Test
    void gameAnswerSamplesDecode() throws Exception {
        assertEquals(new GameAnswer("c17", "g1", 41, new Answer.Confirm(false)),
                decoded("game.answer.confirm.json").msg());
        assertEquals(new GameAnswer("c18", "g1", 42,
                        new Answer.Pick("3f2a9d1e-6c47-4b2e-9a10-8e5d21f7b0c4")),
                decoded("game.answer.object.json").msg());
        assertEquals(new GameAnswer("c19", "g1", 43, new Answer.Mana("U")),
                decoded("game.answer.mana.json").msg());
        assertEquals(new GameAnswer("c20", "g1", 44, new Answer.Cancel()),
                decoded("game.answer.cancel.json").msg());
    }

    // ---- M2: prompts and game events ----

    @Test
    void promptSamplesAreReproducible() throws Exception {
        assertProduces("game.prompt.confirm.json",
                GamePrompt.confirm(12, "Mulligan your hand?", "Mulligan", "Keep")
                        .emitted(204, "g1"));
        assertProduces("game.prompt.priority.json",
                GamePrompt.priority(41, "Play instants and activated abilities",
                                Map.of("3f2a9d1e-6c47-4b2e-9a10-8e5d21f7b0c4",
                                        List.of(new GamePrompt.PlayableAction(
                                                GamePrompt.PlayableAction.CAST, "Cast Counterspell"))))
                        .emitted(813, "g1"));
        assertProduces("game.prompt.chooseTargets.json",
                GamePrompt.chooseTargets(23, "Select target creature (selected 1 of 2)",
                                List.of("aaa-1", "bbb-2"), 1, 2, true, null,
                                new GamePrompt.Progress(1, 2), null)
                        .emitted(511, "g1"));
        assertProduces("game.prompt.payMana.json",
                GamePrompt.payMana(18, "Pay {1}{U}", "{1}{U}", List.of("land-1", "land-2"), true)
                        .emitted(322, "g1"));
    }

    @Test
    void promptDoneSampleIsReproducible() throws Exception {
        assertProduces("game.promptDone.json",
                new PromptDone(814, "g1", 41, PromptDone.Reason.ANSWERED));
    }

    @Test
    void gameLogSampleIsReproducible() throws Exception {
        assertProduces("game.log.json", new LogEntry(815, "g1", 1784259200000L,
                LogEntry.Kind.GAME, "T2.M1", "Ricardo casts Arcane Signet",
                List.of(new LogEntry.Ref("sig-1", "Arcane Signet")), "p1"));
    }

    @Test
    void gameOverSampleIsReproducible() throws Exception {
        assertProduces("game.over.json", new GameOver(2101, "g1",
                List.of("p3"), "Player ai_2 is the winner", true));
    }

    @Test
    void keyframeSampleIsReproducible() throws Exception {
        GameState state = new GameState(
                "g1",
                GameState.Status.ACTIVE,
                new GameState.Turn(3, Phase.PRECOMBAT_MAIN, Step.PRE_MAIN, "p1", "p1"),
                List.of(
                        new Player("p1", "Ricardo", true, 40,
                                null,
                                new Player.ManaPool(0, 1, 0, 0, 0, 0),
                                92, 1,
                                List.of(new Permanent("perm-1", "Command Tower", "C21", "263",
                                        null, 0, List.of("LAND"), List.of(), List.of(), List.of(),
                                        List.of("{T}: Add one mana of any color in your commander's color identity."),
                                        null, null, null, null, null, null, null,
                                        "p1", true, null, null, null, null, null, null, null, null)),
                                List.of(new Card("gy-1", "Arcane Signet", "C21", "251", "{2}", 2,
                                        List.of("ARTIFACT"), List.of(), List.of(), List.of(),
                                        List.of("{T}: Add one mana of any color in your commander's color identity."),
                                        null, null, null, null, null, null, null)),
                                List.of(),
                                List.of(new CommandObject("cmd-1", "Lathril, Blade of the Elves",
                                        "KHM", "222", "{2}{B}{G}", 4,
                                        List.of("CREATURE"), List.of("Elf", "Noble"), List.of("Legendary"),
                                        List.of(Color.B, Color.G), List.of("Menace"),
                                        "2", "3", null, null, null, null, null,
                                        CommandObject.Kind.COMMANDER, null)),
                                null, null, null),
                        new Player("p2", "ai_1", false, 38,
                                List.of(new Counter("poison", 1)),
                                new Player.ManaPool(0, 0, 0, 0, 0, 0),
                                88, 7,
                                List.of(), List.of(), List.of(), List.of(),
                                null, null, null)),
                List.of(new StackItem("stack-1", "p2", StackItem.Kind.SPELL,
                        new Card("stack-1", "Reality Shift", "CMR", "88", "{1}{U}", 2,
                                List.of("INSTANT"), List.of(), List.of(), List.of(Color.U),
                                List.of("Exile target creature."),
                                null, null, null, null, null, null, null),
                        List.of("Exile target creature."),
                        List.of("perm-1"))),
                null, null, null,
                new GameState.Me("p1", List.of(new Card("hand-1", "Elvish Mystic", "C21", "155",
                        "{G}", 1, List.of("CREATURE"), List.of("Elf", "Druid"), List.of(),
                        List.of(Color.G), List.of("{T}: Add {G}."),
                        "1", "1", null, null, null, null, null))));
        assertProduces("game.state.json", new StateKeyframe(2, "g1", Json.tree(state)));
    }
}
