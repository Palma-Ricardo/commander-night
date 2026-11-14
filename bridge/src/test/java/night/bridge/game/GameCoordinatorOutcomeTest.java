package night.bridge.game;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Protocol §11: a server-error end names no winner, whatever XMage's GAME_OVER says. */
class GameCoordinatorOutcomeTest {

    private static GameCoordinator coordinator() {
        return new GameCoordinator("TEST", null, null, 0);
    }

    @Test
    void aRealWinIsParsed() {
        GameCoordinator c = coordinator();
        c.recordGameOver("Player cn_TEST_1 is the winner");
        assertEquals("cn_TEST_1", c.outcome().winnerName());
    }

    /** 1.4.63 GameController.endGameWithError → GAME_OVER reads like a real win. */
    @Test
    void aServerErrorEndOverridesTheTechnicalWinner() {
        GameCoordinator c = coordinator();
        c.recordGameOver("Player cn_TEST_1 is the winner");
        c.recordServerError();
        GameCoordinator.Outcome o = c.outcome();
        assertNull(o.winnerName());
        assertEquals(GameCoordinator.SERVER_ERROR_REASON, o.reason());
    }

    /** The exact texts 1.4.63 emits on its two crash paths, and the non-fatal one it doesn't end on. */
    @Test
    void recognisesXmagesErrorEndTexts() {
        assertTrue(GameCoordinator.endsGameOnError(
                "Game stopped due server error and can't be continued\n\njava.lang.NullPointerException"));
        assertTrue(GameCoordinator.endsGameOnError(
                "Game end on critical error: java.lang.IllegalStateException: boom\n\n..."));
        assertTrue(GameCoordinator.endsGameOnError(
                "Game stopped due critical error, technical winner: cn_TEST_2 (decided by life). "
                        + "Reason: game thread error: java.lang.NullPointerException"));

        assertFalse(GameCoordinator.endsGameOnError("Game error occurred: java.lang.NullPointerException"));
        assertFalse(GameCoordinator.endsGameOnError("Player cn_TEST_1 is the winner"));
        assertFalse(GameCoordinator.endsGameOnError(null));
    }
}
