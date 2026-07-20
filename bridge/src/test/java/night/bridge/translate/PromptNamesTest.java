package night.bridge.translate;

import night.bridge.proto.GamePrompt;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.function.UnaryOperator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;

/**
 * Protocol §8: prompts are player-facing text, so they must speak lobby display
 * names. State, log lines and the game-over reason were rewritten from C1, but
 * prompts were left on the C3 TODO and shipped raw XMage {@code cn_<code>_<n>}
 * usernames to the table (live, 2026-07-20).
 */
class PromptNamesTest {

    /** Stands in for SeatPump's username→display-name map. */
    private static final UnaryOperator<String> RENAME = s -> s == null ? null
            : s.replace("cn_ABC123_1", "Reficul").replace("cn_ABC123_2", "Nyx");

    private static GamePrompt rewrite(GamePrompt p) {
        return PromptNames.rewrite(p, RENAME);
    }

    @Test
    void messageIsRewritten() {
        GamePrompt p = rewrite(GamePrompt.confirm(1, "Sacrifice a creature for cn_ABC123_1?", "Yes", "No"));
        assertEquals("Sacrifice a creature for Reficul?", p.message());
    }

    @Test
    void chooseTargetsZoneIsRewritten() {
        // The C4 dead-end case: "Select a nonland card from <opponent> graveyard".
        GamePrompt p = rewrite(GamePrompt.chooseTargets(1,
                "Select a nonland card from cn_ABC123_2 graveyard",
                List.of("card-1"), 1, 1, true, "cn_ABC123_2 graveyard", null, List.of()));
        assertEquals("Select a nonland card from Nyx graveyard", p.message());
        assertEquals("Nyx graveyard", p.zone());
    }

    @Test
    void optionLabelsAreRewrittenButKeysAreNot() {
        GamePrompt p = rewrite(GamePrompt.playerRequest(1, "cn_ABC123_1 requests a rollback",
                "ROLLBACK_TURNS", List.of(GamePrompt.Option.byKey("cn_ABC123_1", "Grant cn_ABC123_1"))));
        assertEquals("Reficul requests a rollback", p.message());
        assertEquals("Grant Reficul", p.options().getFirst().text());
        assertEquals("cn_ABC123_1", p.options().getFirst().key(),
                "keys are answered back to XMage verbatim — renaming one would break the reply");
    }

    @Test
    void distributeRowLabelsAreRewritten() {
        GamePrompt p = rewrite(GamePrompt.distribute(1, "Distribute damage", 3, 0,
                List.of(new GamePrompt.Among("r0", "cn_ABC123_2", 0, 3, null)), true));
        assertEquals("Nyx", p.among().getFirst().label());
    }

    @Test
    void playableActionTextAndCombatSpecialAreRewritten() {
        GamePrompt p = rewrite(GamePrompt.priority(1, "cn_ABC123_1, play a land",
                Map.of("perm-1", List.of(new GamePrompt.PlayableAction("cast", "Attack cn_ABC123_2"))),
                new GamePrompt.Combat("attackers", List.of("perm-1"), List.of(), "All attack cn_ABC123_2")));
        assertEquals("Reficul, play a land", p.message());
        assertEquals("Attack Nyx", p.playable().get("perm-1").getFirst().text());
        assertEquals("All attack Nyx", p.combat().special());
    }

    @Test
    void nullTextFieldsSurviveUntouched() {
        GamePrompt p = rewrite(GamePrompt.chooseAmount(1, "How many?", 0, 5));
        assertEquals("How many?", p.message());
        assertNull(p.zone());
        assertNull(p.options());
        assertNull(p.combat());
    }

    @Test
    void aPromptWithNoNamesIsReturnedUnchanged() {
        // Cheap identity check keeps the common case allocation-free.
        GamePrompt p = GamePrompt.confirm(1, "Pay {2}?", "Yes", "No");
        assertSame(p, rewrite(p));
    }
}
