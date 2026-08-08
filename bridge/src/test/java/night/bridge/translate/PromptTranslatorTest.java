package night.bridge.translate;

import mage.view.GameClientMessage;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.state.CombatGroup;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.Permanent;
import night.bridge.proto.state.Player;
import org.junit.jupiter.api.Test;

import java.io.Serializable;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Callback payload → prompt shape, on hand-built GameClientMessages (real
 * captured payloads become the golden-fixture tier in M5).
 */
class PromptTranslatorTest {

    @Test
    void confirmCarriesCustomButtonTexts() {
        Map<String, Serializable> options = new HashMap<>();
        options.put("UI.left.btn.text", "Mulligan");
        options.put("UI.right.btn.text", "Keep");
        GameClientMessage msg = new GameClientMessage(null, options, "Mulligan your hand?");
        GamePrompt p = PromptTranslator.confirm(7, msg);
        assertEquals(GamePrompt.Kind.CONFIRM, p.kind());
        assertEquals(7, p.promptId());
        assertEquals("Mulligan your hand?", p.message());
        assertEquals("Mulligan", p.yesText());
        assertEquals("Keep", p.noText());
    }

    @Test
    void confirmWithoutOptionsHasNoButtonTexts() {
        GamePrompt p = PromptTranslator.confirm(1, new GameClientMessage(null, null, "Pass anyway?"));
        assertNull(p.yesText());
        assertNull(p.noText());
    }

    @Test
    void priorityWithoutViewHasEmptyPlayable() {
        GamePrompt p = PromptTranslator.priority(3,
                new GameClientMessage(null, null, "Play spells and abilities"), null, null, null);
        assertEquals(GamePrompt.Kind.PRIORITY, p.kind());
        assertTrue(p.playable().isEmpty());
        assertEquals(Boolean.TRUE, p.canPass());
        assertNull(p.combat());
    }

    // ---- combat declaration (GAME_SELECT with possibleAttackers/possibleBlockers) ----

    @Test
    void attackersAskBecomesCombatPriorityWithEmptyPlayable() {
        UUID elf = UUID.randomUUID();
        UUID bear = UUID.randomUUID();
        Map<String, Serializable> options = new HashMap<>();
        options.put("possibleAttackers", new java.util.ArrayList<>(java.util.List.of(elf, bear)));
        options.put("specialButton", "All attack");
        GamePrompt p = PromptTranslator.priority(16,
                new GameClientMessage(null, options, "Select attackers"), null, null, null);
        assertEquals(GamePrompt.Kind.PRIORITY, p.kind());
        assertTrue(p.playable().isEmpty(), "a combat ask is not a cast window");
        assertEquals(new GamePrompt.Combat(GamePrompt.Combat.ATTACKERS,
                java.util.List.of(elf.toString(), bear.toString()),
                java.util.List.of(), "All attack"), p.combat());
    }

    @Test
    void blockersAskCarriesNoSpecialButton() {
        Map<String, Serializable> options = new HashMap<>();
        options.put("possibleBlockers", new java.util.ArrayList<>(java.util.List.of(UUID.randomUUID())));
        GamePrompt p = PromptTranslator.priority(17,
                new GameClientMessage(null, options, "Select blockers"), null, null, null);
        assertEquals(GamePrompt.Combat.BLOCKERS, p.combat().role());
        assertNull(p.combat().special());
        assertTrue(p.combat().declared().isEmpty());
    }

    @Test
    void declaredCombatantsComeFromStateFilteredToMyBattlefield() {
        Map<String, Serializable> options = new HashMap<>();
        options.put("possibleBlockers", new java.util.ArrayList<>(java.util.List.of(UUID.randomUUID())));
        // my blocker and another defender's blocker share the combat view
        GameState state = state(
                java.util.List.of(player("me", "my-blocker"), player("them", "their-blocker")),
                java.util.List.of(new CombatGroup(java.util.List.of("atk-1"), "me",
                        java.util.List.of("my-blocker", "their-blocker"), true)));
        GamePrompt p = PromptTranslator.priority(18,
                new GameClientMessage(null, options, "Select blockers"), null, state, "me");
        assertEquals(java.util.List.of("my-blocker"), p.combat().declared());
    }

    @Test
    void declaredAttackersComeFromCombatGroups() {
        Map<String, Serializable> options = new HashMap<>();
        options.put("possibleAttackers", new java.util.ArrayList<>(java.util.List.of(UUID.randomUUID())));
        GameState state = state(
                java.util.List.of(player("me", "elf-1", "kni-3"), player("them")),
                java.util.List.of(new CombatGroup(java.util.List.of("kni-3"), "them",
                        java.util.List.of(), false)));
        GamePrompt p = PromptTranslator.priority(19,
                new GameClientMessage(null, options, "Select attackers"), null, state, "me");
        assertEquals(java.util.List.of("kni-3"), p.combat().declared());
    }

    private static GameState state(java.util.List<Player> players, java.util.List<CombatGroup> combat) {
        return new GameState("g1", GameState.Status.ACTIVE, true, null, players,
                java.util.List.of(), combat, null, null, null);
    }

    private static Player player(String id, String... permanentIds) {
        java.util.List<Permanent> battlefield = new java.util.ArrayList<>();
        for (String permanentId : permanentIds) {
            battlefield.add(new Permanent(permanentId, permanentId, null, null, null, 0,
                    java.util.List.of(), java.util.List.of(), java.util.List.of(),
                    java.util.List.of(), java.util.List.of(), null, null, null, null, null,
                    null, null, id, false, null, null, null, null, null, null, null, null, null));
        }
        return new Player(id, id, true, 40, null, new Player.ManaPool(0, 0, 0, 0, 0, 0),
                0, 0, battlefield, java.util.List.of(), java.util.List.of(),
                java.util.List.of(), null, null, null, null);
    }

    @Test
    void chooseTargetsParsesProgressAndCandidates() {
        UUID a = UUID.randomUUID();
        UUID b = UUID.randomUUID();
        Set<UUID> targets = new LinkedHashSet<>();
        targets.add(a);
        targets.add(b);
        GameClientMessage msg = new GameClientMessage(null, null,
                "Select target creatures (selected 1 of 3)", null, targets, true);
        GamePrompt p = PromptTranslator.chooseTargets(4, msg);
        assertEquals(GamePrompt.Kind.CHOOSE_TARGETS, p.kind());
        assertEquals(java.util.List.of(a.toString(), b.toString()), p.candidates());
        assertEquals(new GamePrompt.Progress(1, 3), p.progress());
        assertEquals(3, p.max());
        assertEquals(1, p.min());
        assertEquals(Boolean.TRUE, p.required());
        assertNull(p.cards());
        // The stale server-side "(selected …)" tally is stripped from the display
        // message — the dock's own live counter is the source of truth (play-test #5).
        assertEquals("Select target creatures", p.message());
    }

    @Test
    void fixedCountDiscardParsesTrueMinFromMessage() {
        // XMage's discard-exactly-6 message carries ", min 6"; the true minimum must
        // survive so the client renders the range as "6", not "1–6" (play-test #5).
        GameClientMessage msg = new GameClientMessage(null, null,
                "Select cards to discard (selected 0 of 6, min 6)", null,
                new LinkedHashSet<>(Set.of(UUID.randomUUID())), true);
        GamePrompt p = PromptTranslator.chooseTargets(7, msg);
        assertEquals(6, p.min());
        assertEquals(6, p.max());
        assertEquals(new GamePrompt.Progress(0, 6), p.progress());
        assertEquals("Select cards to discard", p.message());
    }

    @Test
    void singleTargetHasNoProgressAndMaxOne() {
        GameClientMessage msg = new GameClientMessage(null, null,
                "Select target creature to destroy", null, Set.of(UUID.randomUUID()), false);
        GamePrompt p = PromptTranslator.chooseTargets(5, msg);
        assertNull(p.progress());
        assertEquals(1, p.max());
        assertEquals(0, p.min());
        assertEquals(Boolean.FALSE, p.required());
    }

    @Test
    void payManaExtractsRemainingCost() {
        GamePrompt p = PromptTranslator.payMana(6,
                new GameClientMessage(null, null, "Pay {1}{B/P}{B/P} (as Ricardo)"), null);
        assertEquals(GamePrompt.Kind.PAY_MANA, p.kind());
        assertEquals("{1}{B/P}{B/P}", p.remaining());
        assertEquals(Boolean.TRUE, p.canCancel());
        assertNull(p.sources());
    }

    // ---- M7: the object an ask is about (protocol §8 payMana.for) ----

    /** How 1.4.60 renders the paying object into the ask (ManaUtil + GameLog). */
    private static String logName(UUID id, String name) {
        return "<font color='#B0C4DE' object_id='" + id + "'>" + name + "</font> ["
                + id.toString().substring(0, 3) + "]";
    }

    private static String payPrompt(String cost, UUID id, String name) {
        return "Pay " + cost + "<div style='font-size:11pt'>" + logName(id, name) + "</div>";
    }

    @Test
    void payManaCarriesTheObjectWhoseCostIsBeingPaid() {
        UUID card = UUID.randomUUID();
        GamePrompt p = PromptTranslator.payMana(20,
                new GameClientMessage(null, null, payPrompt("{1}{U}", card, "Brainstorm")), null);
        assertEquals("{1}{U}", p.remaining());
        assertEquals(card.toString(), p.forObject());
    }

    @Test
    void payManaWithoutAnObjectLinkOmitsFor() {
        GamePrompt p = PromptTranslator.payMana(21,
                new GameClientMessage(null, null, "Pay {2}"), null);
        assertNull(p.forObject(), "absent beats wrong — the client falls back to its own anchor");
    }

    @Test
    void payManaWithTwoObjectLinksOmitsFor() {
        String message = "Pay {2}<div style='font-size:11pt'>"
                + logName(UUID.randomUUID(), "Mogis, God of Slaughter")
                + logName(UUID.randomUUID(), "Rhystic Study") + "</div>";
        GamePrompt p = PromptTranslator.payMana(22,
                new GameClientMessage(null, null, message), null);
        assertNull(p.forObject(), "an ambiguous anchor is worse than none");
    }

    // ---- M7: which permanent a distribute row divides onto (protocol §8) ----

    private static GameClientMessage rows(mage.util.MultiAmountMessage... rows) {
        Map<String, Serializable> options = new HashMap<>();
        options.put("header", "Assign combat damage");
        return new GameClientMessage(null, options, java.util.List.of(rows), 4, 4);
    }

    @Test
    void distributeRowsCarryTheObjectTheyDivideOnto() {
        UUID bear = UUID.randomUUID();
        UUID elf = UUID.randomUUID();
        GamePrompt p = PromptTranslator.distribute(23, rows(
                new mage.util.MultiAmountMessage(logName(bear, "Grizzly Bears") + ", P/T: 2/2", 0, 4, 2),
                new mage.util.MultiAmountMessage(logName(elf, "Llanowar Elves") + ", P/T: 1/1", 0, 4, 2)),
                null);
        assertEquals(java.util.List.of(bear.toString(), elf.toString()),
                p.among().stream().map(GamePrompt.Among::objectId).toList());
        // The label is XMage's own presentation text; Html.strip removes both the
        // font tags and the trailing "[7d3]" id fragment they carry — protocol §8
        // is plain text, and the abbreviated id is not for the player to read.
        assertEquals(java.util.List.of(
                        "Grizzly Bears, P/T: 2/2",
                        "Llanowar Elves, P/T: 1/1"),
                p.among().stream().map(GamePrompt.Among::label).toList());
    }

    @Test
    void distributeRowsThatNameNoObjectOmitObjectId() {
        // AddManaInAnyCombinationEffect and friends divide across mana letters.
        GamePrompt p = PromptTranslator.distribute(24, rows(
                new mage.util.MultiAmountMessage("R", 0, 4, 0),
                new mage.util.MultiAmountMessage("G", 0, 4, 0)), null);
        p.among().forEach(a -> assertNull(a.objectId()));
    }

    @Test
    void distributeRowNamingAPlayerOmitsObjectId() {
        // PlayerImpl.getLogName is getColoredPlayerName — no object_id attribute.
        GamePrompt p = PromptTranslator.distribute(25, rows(
                new mage.util.MultiAmountMessage("<font color='#20B2AA'>Ricardo</font>", 0, 4, 0)),
                null);
        assertNull(p.among().getFirst().objectId());
    }

    @Test
    void htmlInPromptMessagesIsStripped() {
        GamePrompt p = PromptTranslator.confirm(8,
                new GameClientMessage(null, null, "Cast <b>Opt</b>?<br><i>hint</i>"));
        assertEquals("Cast Opt? hint", p.message());
    }

    // ---- M3 kinds ----

    @Test
    void chooseAbilityKeepsPickerOrderAndIds() {
        UUID first = UUID.randomUUID();
        UUID second = UUID.randomUUID();
        Map<UUID, String> modes = new java.util.LinkedHashMap<>();
        modes.put(first, "1. Cast Far");
        modes.put(second, "2. Cast Away");
        GamePrompt p = PromptTranslator.chooseAbility(9,
                new mage.view.AbilityPickerView(null, modes, "Choose spell or ability to cast"));
        assertEquals(GamePrompt.Kind.CHOOSE_ABILITY, p.kind());
        assertEquals(java.util.List.of(
                        GamePrompt.Option.byId(first.toString(), "1. Cast Far"),
                        GamePrompt.Option.byId(second.toString(), "2. Cast Away")),
                p.options());
    }

    @Test
    void chooseOptionFromKeyChoicesUsesKeysAndSubMessage() {
        mage.choices.ChoiceImpl choice = new mage.choices.ChoiceImpl(true);
        choice.setMessage("Choose a creature type");
        choice.setSubMessage("for Cavern of Souls");
        Map<String, String> keys = new java.util.LinkedHashMap<>();
        keys.put("Elf", "Elf (12 cards)");
        keys.put("Shade", "Shade (1 card)");
        choice.setKeyChoices(keys);
        GamePrompt p = PromptTranslator.chooseOption(10,
                new GameClientMessage(null, null, choice));
        assertEquals(GamePrompt.Kind.CHOOSE_OPTION, p.kind());
        assertEquals("Choose a creature type — for Cavern of Souls", p.message());
        assertEquals(Boolean.TRUE, p.required());
        assertEquals(java.util.List.of(
                        GamePrompt.Option.byKey("Elf", "Elf (12 cards)"),
                        GamePrompt.Option.byKey("Shade", "Shade (1 card)")),
                p.options());
    }

    @Test
    void chooseOptionFromPlainChoicesUsesTheStringAsItsOwnKey() {
        mage.choices.ChoiceImpl choice = new mage.choices.ChoiceImpl(false);
        choice.setMessage("Choose a color");
        Set<String> values = new LinkedHashSet<>();
        values.add("White");
        values.add("Blue");
        choice.setChoices(values);
        GamePrompt p = PromptTranslator.chooseOption(11,
                new GameClientMessage(null, null, choice));
        assertEquals(Boolean.FALSE, p.required());
        assertEquals(java.util.List.of(
                        GamePrompt.Option.byKey("White", "White"),
                        GamePrompt.Option.byKey("Blue", "Blue")),
                p.options());
    }

    @Test
    void choosePileToleratesNullPiles() {
        GamePrompt p = PromptTranslator.choosePile(12,
                new GameClientMessage(null, null, "Choose a pile to put into your hand.",
                        (mage.view.CardsView) null, (mage.view.CardsView) null));
        assertEquals(GamePrompt.Kind.CHOOSE_PILE, p.kind());
        assertEquals(2, p.piles().size());
        assertTrue(p.piles().get(0).isEmpty());
        assertTrue(p.piles().get(1).isEmpty());
    }

    @Test
    void chooseAmountCarriesBounds() {
        GamePrompt p = PromptTranslator.chooseAmount(13,
                new GameClientMessage(null, null, "Announce the value for {X}", 0, Integer.MAX_VALUE));
        assertEquals(GamePrompt.Kind.CHOOSE_AMOUNT, p.kind());
        assertEquals(0, p.min());
        assertEquals(Integer.MAX_VALUE, p.max());
    }

    @Test
    void distributeSynthesizesRowIndexIdsAndReadsHeader() {
        Map<String, Serializable> options = new HashMap<>();
        options.put("title", "Assign damage");
        options.put("header", "Assign damage among targets");
        options.put("canCancel", true);
        java.util.List<mage.util.MultiAmountMessage> rows = java.util.List.of(
                new mage.util.MultiAmountMessage("Goblin Guide", 0, 4, 2),
                new mage.util.MultiAmountMessage("Monastery Swiftspear", 0, 4, 2));
        GamePrompt p = PromptTranslator.distribute(14,
                new GameClientMessage(null, options, rows, 4, 4), null);
        assertEquals(GamePrompt.Kind.DISTRIBUTE, p.kind());
        assertEquals("Assign damage among targets", p.message());
        assertEquals(4, p.total());
        assertEquals(4, p.min());
        assertEquals(Boolean.TRUE, p.canCancel());
        assertEquals(java.util.List.of(
                        new GamePrompt.Among("0", "Goblin Guide", 0, 4, 2),
                        new GamePrompt.Among("1", "Monastery Swiftspear", 0, 4, 2)),
                p.among());
    }

    @Test
    void playerRequestMapsButtonsToActionKeys() {
        mage.view.UserRequestMessage msg = new mage.view.UserRequestMessage(
                "Rollback request", "Ricardo asks to roll the game back to the start of turn 3.");
        msg.setButton1("Deny", mage.constants.PlayerAction.DENY_PERMISSION_TO_ROLLBACK_TURN);
        msg.setButton2("Allow", mage.constants.PlayerAction.ADD_PERMISSION_TO_ROLLBACK_TURN);
        msg.setButton3("Close", null);
        GamePrompt p = PromptTranslator.playerRequest(15, msg);
        assertEquals(GamePrompt.Kind.PLAYER_REQUEST, p.kind());
        assertEquals("Rollback request", p.requestKey());
        assertEquals(java.util.List.of(
                        GamePrompt.Option.byKey("DENY_PERMISSION_TO_ROLLBACK_TURN", "Deny"),
                        GamePrompt.Option.byKey("ADD_PERMISSION_TO_ROLLBACK_TURN", "Allow"),
                        GamePrompt.Option.byKey("dismiss", "Close")),
                p.options());
    }
}
