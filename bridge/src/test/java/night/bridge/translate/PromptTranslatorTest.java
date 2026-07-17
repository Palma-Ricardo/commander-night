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
}
