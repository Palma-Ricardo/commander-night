package night.bridge.live;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/**
 * Coverage goals for the live tier: things we want a game to exercise but that depend on
 * how a randomly shuffled game against the AIs plays out (combat happening, the game
 * running long enough for a resync, staying under the byte budget in a very long game).
 *
 * <p>Tests must be deterministic, so these never fail a test. Hard assertions are kept
 * for invariants that hold in every game. A goal is printed as a {@code [coverage]} line
 * and, under GitHub Actions, appended to the job summary so a missed goal stays visible.
 * Deterministic coverage of these paths lives in the unit and golden tiers.
 */
final class Coverage {

    private Coverage() {
    }

    static void goal(String test, String goal, boolean met, String detail) {
        String status = met ? "MET" : "MISSED";
        System.out.printf("[coverage] %s %s: %s (%s)%n", status, test, goal, detail);
        String summary = System.getenv("GITHUB_STEP_SUMMARY");
        if (summary == null || summary.isBlank()) {
            return;
        }
        String row = String.format("| %s | `%s` | %s | %s |%n", met ? "✅" : "⚠️", test, goal, detail);
        try {
            Files.writeString(Path.of(summary), row, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException e) {
            System.out.println("[coverage] could not write the job summary: " + e.getMessage());
        }
    }
}
