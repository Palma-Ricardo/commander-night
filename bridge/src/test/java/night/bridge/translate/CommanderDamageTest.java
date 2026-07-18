package night.bridge.translate;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Pinned to the exact strings 1.4.60's {@code CommanderInfoWatcher} builds
 * (source-verified): marker {@code <b>Commander</b>}, tax suffix
 * {@code " N time(s) played from the command zone."}, damage line
 * {@code "<b>Commander</b> did N combat damage to player <font
 * color='#20B2AA'>Name</font>."} (the font wrapper is
 * {@code GameLog.getColoredPlayerName}). If an upgrade changes any of these,
 * this test and the golden fixtures are the tripwire.
 */
class CommanderDamageTest {

    private static final String MARKER = "<b>Commander</b>";

    @Test
    void bareMarkerMeansCastCountZero() {
        var s = CommanderDamage.scrape(List.of("Flying", MARKER));
        assertEquals(0, s.castCount());
        assertTrue(s.isCommander());
        assertTrue(s.damageByPlayerName().isEmpty());
        assertEquals(List.of("Flying"), s.remainingRules());
    }

    @Test
    void taxSuffixSingular() {
        var s = CommanderDamage.scrape(List.of(MARKER + " 1 time played from the command zone."));
        assertEquals(1, s.castCount());
        assertTrue(s.remainingRules().isEmpty());
    }

    @Test
    void taxSuffixPlural() {
        var s = CommanderDamage.scrape(List.of(MARKER + " 3 times played from the command zone."));
        assertEquals(3, s.castCount());
    }

    @Test
    void damageLineExtractsStrippedPlayerName() {
        var s = CommanderDamage.scrape(List.of(
                MARKER,
                MARKER + " did 7 combat damage to player <font color='#20B2AA'>Alice</font>."));
        assertEquals(Map.of("Alice", 7), s.damageByPlayerName());
        assertTrue(s.remainingRules().isEmpty());
    }

    @Test
    void multipleDamageLinesOnePerVictim() {
        var s = CommanderDamage.scrape(List.of(
                "Deathtouch",
                MARKER + " 2 times played from the command zone.",
                MARKER + " did 21 combat damage to player <font color='#20B2AA'>Bob</font>.",
                MARKER + " did 4 combat damage to player <font color='#20B2AA'>seat_XK7PQ2_3</font>."));
        assertEquals(2, s.castCount());
        assertEquals(21, s.damageByPlayerName().get("Bob"));
        assertEquals(4, s.damageByPlayerName().get("seat_XK7PQ2_3"));
        assertEquals(List.of("Deathtouch"), s.remainingRules());
    }

    @Test
    void nonCommanderRulesPassThroughUntouched() {
        List<String> rules = List.of(
                "Commander ninjutsu {U}{B} ({U}{B}, Return an unblocked attacker you control to hand: Put this card onto the battlefield from your hand tapped and attacking.)",
                "Partner with Silas Renn, Seeker Adept",
                "Commander");   // plain text, no <b> wrapper — not the watcher's line
        var s = CommanderDamage.scrape(rules);
        assertNull(s.castCount());
        assertFalse(s.isCommander());
        assertEquals(rules, s.remainingRules());
    }

    @Test
    void driftedWatcherTextStaysInRules() {
        // A hypothetical 1.4.61 rewording: canary-logged, line kept, fields absent.
        String drifted = "<b>Commander</b> has dealt 7 combat damage to player <font color='#20B2AA'>Alice</font>.";
        var s = CommanderDamage.scrape(List.of(drifted));
        assertTrue(s.damageByPlayerName().isEmpty());
        assertEquals(List.of(drifted), s.remainingRules());
    }

    @Test
    void nullAndEmptyInputs() {
        assertNull(CommanderDamage.scrape(null).castCount());
        assertTrue(CommanderDamage.scrape(List.of()).remainingRules().isEmpty());
    }
}
