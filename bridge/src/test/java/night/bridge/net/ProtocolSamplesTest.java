package night.bridge.net;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import night.bridge.proto.Ack;
import night.bridge.proto.Answer;
import night.bridge.proto.ChatSend;
import night.bridge.proto.Err;
import night.bridge.proto.ErrorCode;
import night.bridge.proto.GameAction;
import night.bridge.proto.GameAnswer;
import night.bridge.proto.GameOver;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.GameResync;
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
import night.bridge.proto.StatePatch;
import night.bridge.proto.Welcome;
import night.bridge.proto.event.AttackEvent;
import night.bridge.proto.event.BlockEvent;
import night.bridge.proto.event.Cause;
import night.bridge.proto.event.CountersEvent;
import night.bridge.proto.event.DamageEvent;
import night.bridge.proto.event.GameEvent;
import night.bridge.proto.event.HiddenEvent;
import night.bridge.proto.event.LifeEvent;
import night.bridge.proto.event.MoveEvent;
import night.bridge.proto.event.RevealEvent;
import night.bridge.proto.event.ScryEvent;
import night.bridge.proto.event.SearchEvent;
import night.bridge.proto.event.ShuffleEvent;
import night.bridge.proto.event.StackLinkEvent;
import night.bridge.proto.event.StepEvent;
import night.bridge.proto.event.TapEvent;
import night.bridge.proto.event.TriggerEvent;
import night.bridge.proto.event.UntapEvent;
import night.bridge.proto.event.Verb;
import night.bridge.proto.event.Zone;
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
    void helloKeyframesModeDecodes() throws Exception {
        Codec.Decoded.Ok ok = assertInstanceOf(Codec.Decoded.Ok.class,
                codec.decode(sample("session.hello.keyframes.json").toString()));
        assertEquals(new Hello("c2", 1, "kZ1xW3vJqL8mN5aPbT9cDg", null, "keyframes"), ok.msg());
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
                        new LobbyState.DeckInfo(true, List.of("Lathril, Blade of the Elves"), 100,
                                "dck", List.of(), List.of()),
                        true))));
    }

    /**
     * The deck info's optional arrays are omitted when empty, never sent as {@code []}
     * (protocol §5) — asserted here on the warnings sample, whose {@code problems} is
     * empty and whose {@code warnings} is not.
     */
    @Test
    void lobbyStateDeckWarningsSampleIsReproducible() throws Exception {
        assertProduces("lobby.state.deck-warnings.json", new LobbyState(
                "K7M2QX",
                "9c1d3e5f-2a4b-4c6d-8e0f-1a2b3c4d5e6f",
                List.of(new LobbyState.Seat(
                        "9c1d3e5f-2a4b-4c6d-8e0f-1a2b3c4d5e6f",
                        "Ricardo",
                        new LobbyState.DeckInfo(true,
                                List.of("Rose Tyler", "The Tenth Doctor"), 100, "moxfield",
                                List.of(),
                                List.of("ignored 10 cards in section PLANES:",
                                        "Aura of Silence — no PLST:C15-60 printing, used C15:60")),
                        false))));
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

    // ---- M7: the object an ask is about (protocol §8) ----

    @Test
    void payManaWithAnAnchorIsReproducible() throws Exception {
        assertProduces("game.prompt.payMana.for.json",
                GamePrompt.payMana(19, "Pay {1}{G}Life from the Loam [4fb]", "{1}{G}",
                                List.of("land-1", "land-2"), true,
                                "4fb07bce-68ec-412b-91e6-8dfe2e629ae1")
                        .emitted(323, "g1"));
    }

    @Test
    void distributeWithRowAnchorsIsReproducible() throws Exception {
        // Row 0 resolved (its label carried an object link); row 1 did not — a
        // face-down blocker has no name to match and omits the field entirely.
        assertProduces("game.prompt.distribute.objectId.json",
                GamePrompt.distribute(48,
                                "Assign combat damage among creatures blocking Goblin Guide, P/T: 2/2",
                                2, 2, List.of(
                                        new GamePrompt.Among("0", "Grizzly Bears [7d3], P/T: 2/2",
                                                0, 2, 2, "7d3f9c21-4a8b-4e55-9f10-2c6d8b31e0a7"),
                                        new GamePrompt.Among("1", "creature without name, P/T: 2/2",
                                                0, 2, 0)), false)
                        .emitted(903, "g1"));
    }

    @Test
    void combatPrioritySampleIsReproducible() throws Exception {
        assertProduces("game.prompt.priority.combat.json",
                GamePrompt.priority(44, "Select attackers", Map.of(),
                                new GamePrompt.Combat(GamePrompt.Combat.ATTACKERS,
                                        List.of("elf-1", "elf-2"), List.of("kni-3"), "All attack"))
                        .emitted(915, "g1"));
    }

    @Test
    void promptDoneSampleIsReproducible() throws Exception {
        assertProduces("game.promptDone.json",
                new PromptDone(814, "g1", 41, PromptDone.Reason.ANSWERED));
    }

    // ---- M3: the remaining prompt kinds ----

    private static Card spell(String id, String name, String set, String number, String manaCost,
                              int manaValue, String type, String text) {
        return new Card(id, name, set, number, manaCost, manaValue, List.of(type), List.of(),
                List.of(), List.of(Color.U), List.of(text), null, null, null, null, null, null, null, null, null);
    }

    @Test
    void m3PromptSamplesAreReproducible() throws Exception {
        assertProduces("game.prompt.chooseAbility.json",
                GamePrompt.chooseAbility(24, "Choose spell or ability to cast", List.of(
                                GamePrompt.Option.byId("3f2a9d1e-6c47-4b2e-9a10-8e5d21f7b0c4", "1. Cast Far"),
                                GamePrompt.Option.byId("9b8c7d6e-5f4a-4b2c-8d0e-f9a8b7c6d5e4", "2. Cast Away")))
                        .emitted(518, "g1"));
        assertProduces("game.prompt.chooseOption.json",
                GamePrompt.chooseOption(25, "Choose a creature type — for Cavern of Souls", List.of(
                                GamePrompt.Option.byKey("Elf", "Elf"),
                                GamePrompt.Option.byKey("Shade", "Shade")), true)
                        .emitted(530, "g1"));
        assertProduces("game.prompt.choosePile.json",
                GamePrompt.choosePile(31, "Choose a pile to put into your hand.",
                                List.of(spell("pile-a1", "Counterspell", "MH2", "267", "{U}{U}", 2,
                                        "INSTANT", "Counter target spell.")),
                                List.of(spell("pile-b1", "Brainstorm", "MH2", "393", "{U}", 1, "INSTANT",
                                                "Draw three cards, then put two cards from your hand on top of your library in any order."),
                                        spell("pile-b2", "Ponder", "C18", "97", "{U}", 1, "SORCERY",
                                                "Look at the top three cards of your library, then put them back in any order. You may shuffle. Draw a card.")))
                        .emitted(610, "g1"));
        assertProduces("game.prompt.chooseAmount.json",
                GamePrompt.chooseAmount(19, "Announce the value for {X}", 0, Integer.MAX_VALUE)
                        .emitted(403, "g1"));
        assertProduces("game.prompt.distribute.json",
                GamePrompt.distribute(47, "Assign damage among targets", 4, 4, List.of(
                                new GamePrompt.Among("0", "Goblin Guide", 0, 4, 2),
                                new GamePrompt.Among("1", "Monastery Swiftspear", 0, 4, 2)), false)
                        .emitted(902, "g1"));
        assertProduces("game.prompt.playerRequest.json",
                GamePrompt.playerRequest(52, "Ricardo asks to roll the game back to the start of turn 3.",
                                "Request by Ricardo", List.of(
                                        GamePrompt.Option.byKey("ADD_PERMISSION_TO_ROLLBACK_TURN", "Accept"),
                                        GamePrompt.Option.byKey("DENY_PERMISSION_TO_ROLLBACK_TURN", "Deny")))
                        .emitted(1101, "g1"));
    }

    // ---- M3: patches, resync, actions ----

    @Test
    void gamePatchSampleIsReproducible() throws Exception {
        // ops ride verbatim (zjsonpatch output) — the envelope is what's under test
        JsonNode ops = sample("game.patch.json").get("ops");
        assertProduces("game.patch.json", new StatePatch(812, "g1", 810, ops));
    }

    // ---- M6: semantic events (protocol §7.1) ----

    @Test
    void gamePatchWithEventsIsReproducible() throws Exception {
        // ops ride verbatim; the events array is the shape under test — one of each
        // §7.1 kind, in array order, exercising the optional-field omission (NON_NULL):
        // tap.forMana present but untap's absent, life/counters carry no cause.
        JsonNode ops = sample("game.patch.events.json").get("ops");
        List<GameEvent> events = List.of(
                new MoveEvent("sdt-1", Zone.HAND, Zone.STACK, Verb.CAST),
                new StackLinkEvent("stk-9", "sdt-1"),
                new MoveEvent("eng-2", Zone.BATTLEFIELD, Zone.GRAVEYARD, Verb.DESTROY,
                        new Cause("swords-3", "Swords to Plowshares", null), null),
                new HiddenEvent("p3", Zone.LIBRARY, Zone.HAND, 1, Verb.DRAW),
                new TapEvent("sol-4", Boolean.TRUE),
                new UntapEvent("forest-5"),
                new AttackEvent(List.of("krenko-6"), "p1"),
                new BlockEvent("krenko-6", List.of("wall-7")),
                new DamageEvent("p1", 3, true, new Cause("krenko-6", "Krenko, Mob Boss", null)),
                new LifeEvent("p1", 34, 31),
                new CountersEvent("walker-8", "+1/+1", 2, 3),
                new TriggerEvent("solemn-9", "ab-10"),
                new RevealEvent(List.of("top-11"), "p1"),
                new ShuffleEvent("p1"),
                new ScryEvent("p1"),
                new SearchEvent("p1"),
                new StepEvent(null, null, "p2"));
        assertProduces("game.patch.events.json", new StatePatch(902, "g1", 900, ops, events));
    }

    @Test
    void gameResyncSampleDecodes() throws Exception {
        assertEquals(new GameResync("c30", "g1"), decoded("game.resync.json").msg());
    }

    // ---- M4: chat ----

    @Test
    void chatSendSampleDecodes() throws Exception {
        assertEquals(new ChatSend("c40", "g1", "gg — that Lathril swing was brutal"),
                decoded("chat.send.json").msg());
    }

    @Test
    void gameActionSamplesDecode() throws Exception {
        assertEquals(new GameAction("c31", "g1", new GameAction.Action.Concede()),
                decoded("game.action.concede.json").msg());
        assertEquals(new GameAction("c32", "g1",
                        new GameAction.Action.Skip(GameAction.Action.Skip.Mode.END_OF_TURN)),
                decoded("game.action.skip.json").msg());
        assertEquals(new GameAction("c33", "g1", new GameAction.Action.RequestRollback(1)),
                decoded("game.action.rollback.json").msg());
        assertEquals(new GameAction("c34", "g1", new GameAction.Action.AutoMana(false)),
                decoded("game.action.autoMana.json").msg());
        assertEquals(new GameAction("c35", "g1",
                        new GameAction.Action.TriggerOrder(GameAction.Action.TriggerOrder.Mode.RESET)),
                decoded("game.action.triggerOrder.json").msg());
    }

    @Test
    void m3AnswerSamplesDecode() throws Exception {
        assertEquals(new GameAnswer("c21", "g1", 45, new Answer.Picks(List.of("aaa-1", "bbb-2"))),
                decoded("game.answer.objects.json").msg());
        assertEquals(new GameAnswer("c22", "g1", 46, new Answer.Amount(7)),
                decoded("game.answer.number.json").msg());
        assertEquals(new GameAnswer("c23", "g1", 47, new Answer.Option("Shade")),
                decoded("game.answer.option.json").msg());
        assertEquals(new GameAnswer("c24", "g1", 48, new Answer.Pile(1)),
                decoded("game.answer.pile.json").msg());
        assertEquals(new GameAnswer("c25", "g1", 49, new Answer.Distribution(List.of(
                        new Answer.Distribution.Share("0", 3), new Answer.Distribution.Share("1", 1)))),
                decoded("game.answer.distribution.json").msg());
    }

    @Test
    void gameLogSampleIsReproducible() throws Exception {
        assertProduces("game.log.json", new LogEntry(815, "g1", 1784259200000L,
                LogEntry.Kind.GAME, "T2.M1", "Ricardo casts Arcane Signet",
                List.of(new LogEntry.Ref("sig-1", "Arcane Signet")), "p1"));
        // the chat.send echo (§10): same envelope, kind:'chat', no turn/refs
        assertProduces("game.log.chat.json", new LogEntry(1930, "g1", 1784259300000L,
                LogEntry.Kind.CHAT, null, "gg — that Lathril swing was brutal", null, "p1"));
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
                true,
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
                                        null, null, null, null, null, null, null, null, null)),
                                List.of(),
                                List.of(new CommandObject("cmd-1", "Lathril, Blade of the Elves",
                                        "KHM", "222", "{2}{B}{G}", 4,
                                        List.of("CREATURE"), List.of("Elf", "Noble"), List.of("Legendary"),
                                        List.of(Color.B, Color.G), List.of("Menace"),
                                        "2", "3", null, null, null, null, null,
                                        CommandObject.Kind.COMMANDER, 1)),
                                null, null, null),
                        new Player("p2", "ai_1", false, 38,
                                List.of(new Counter("poison", 1)),
                                new Player.ManaPool(0, 0, 0, 0, 0, 0),
                                88, 7,
                                List.of(), List.of(), List.of(), List.of(),
                                List.of(new Player.CommanderDamage("cmd-1", 5)),
                                null, null)),
                List.of(new StackItem("stack-1", "p2", StackItem.Kind.SPELL,
                        new Card("stack-1", "Reality Shift", "CMR", "88", "{1}{U}", 2,
                                List.of("INSTANT"), List.of(), List.of(), List.of(Color.U),
                                List.of("Exile target creature."),
                                null, null, null, null, null, null, null, null, null),
                        List.of("Exile target creature."),
                        List.of("perm-1"))),
                null, null, null,
                new GameState.Me("p1", List.of(new Card("hand-1", "Elvish Mystic", "C21", "155",
                        "{G}", 1, List.of("CREATURE"), List.of("Elf", "Druid"), List.of(),
                        List.of(Color.G), List.of("{T}: Add {G}."),
                        "1", "1", null, null, null, null, null, null, null)),
                        GameState.Me.Skip.STACK));
        assertProduces("game.state.json", new StateKeyframe(2, "g1", Json.tree(state)));
    }

    @Test
    void stateKeyframeMulliganWindowReproduces() throws Exception {
        // The pre-game mulligan window (observed live 2026-07-18): no phase/
        // step/activePlayerId until the first untap — optional in v1.md §6.
        // Commanders carry castCount 0 from the first keyframe (§16.3).
        GameState state = new GameState(
                "g1",
                GameState.Status.ACTIVE,
                true,
                new GameState.Turn(1, null, null, null, null),
                List.of(
                        new Player("p1", "Ricardo", true, 40,
                                null,
                                new Player.ManaPool(0, 0, 0, 0, 0, 0),
                                92, 7,
                                List.of(), List.of(), List.of(),
                                List.of(new CommandObject("cmd-1", "Lathril, Blade of the Elves",
                                        "KHM", "222", "{2}{B}{G}", 4,
                                        List.of("CREATURE"), List.of("Elf", "Noble"), List.of("Legendary"),
                                        List.of(Color.B, Color.G), List.of("Menace"),
                                        "2", "3", null, null, null, null, null,
                                        CommandObject.Kind.COMMANDER, 0)),
                                null, null, null),
                        new Player("p2", "ai_1", false, 40,
                                null,
                                new Player.ManaPool(0, 0, 0, 0, 0, 0),
                                92, 7,
                                List.of(), List.of(), List.of(), List.of(),
                                null, null, null)),
                List.of(),
                null, null, null,
                new GameState.Me("p1", List.of(new Card("hand-1", "Elvish Mystic", "C21", "155",
                        "{G}", 1, List.of("CREATURE"), List.of("Elf", "Druid"), List.of(),
                        List.of(Color.G), List.of("{T}: Add {G}."),
                        "1", "1", null, null, null, null, null, null, null)),
                        null));
        assertProduces("game.state.mulligan.json", new StateKeyframe(0, "g1", Json.tree(state)));
    }
}
