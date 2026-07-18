package night.bridge.translate;

import mage.view.GameClientMessage;
import night.bridge.proto.GamePrompt;
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
                new GameClientMessage(null, null, "Play spells and abilities"), null);
        assertEquals(GamePrompt.Kind.PRIORITY, p.kind());
        assertTrue(p.playable().isEmpty());
        assertEquals(Boolean.TRUE, p.canPass());
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
                new GameClientMessage(null, options, rows, 4, 4));
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
