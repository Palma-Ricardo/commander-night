package night.bridge.lobby.deck;

import mage.cards.repository.CardRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * Access to XMage's own card database (design: deck import spec §3).
 *
 * <p><b>Why the guard.</b> {@code CardRepository}'s constructor compares the
 * {@code Build-Time} of the jar holding {@code CardRepository.class} against a
 * value stored in the database and, on a mismatch, runs
 * {@code TableUtils.dropTable(CardInfo.class, true)} — wiping a table only the
 * game server's set scanner can rebuild. It should never fire (we load the same
 * pinned {@code mage-1.4.60.jar}), but a bridge start that destroys the game
 * server's card database is not a failure we are willing to risk. So a plain
 * JDBC read confirms the table is intact <em>before</em> any CardRepository
 * touch, and startup aborts rather than letting it "repair" anything.
 */
public final class CardDb {

    private static final Logger log = LoggerFactory.getLogger(CardDb.class);

    /** XMage 1.4.60 ships ~100k rows; anything near-empty means a wiped or half-built db. */
    private static final int MIN_PLAUSIBLE_CARDS = 20_000;

    private static final String URL = "jdbc:h2:file:./db/cards.h2;AUTO_SERVER=TRUE;IGNORECASE=TRUE";

    private static volatile boolean checked;

    /**
     * Verifies the card database is present and populated. Idempotent; throws
     * {@link IllegalStateException} with a operator-actionable message otherwise.
     */
    public static synchronized void require() {
        if (checked) {
            return;
        }
        int count;
        try (Connection c = DriverManager.getConnection(URL, "", "");
             Statement s = c.createStatement();
             ResultSet rs = s.executeQuery("SELECT count(*) FROM card")) {
            rs.next();
            count = rs.getInt(1);
        } catch (SQLException e) {
            throw new IllegalStateException(
                    "cannot read XMage's card database at ./db/cards.h2 — deck import needs it. "
                            + "Expected a symlink 'db' pointing at the dist's mage-server/db directory. "
                            + "Cause: " + e.getMessage(), e);
        }
        if (count < MIN_PLAUSIBLE_CARDS) {
            throw new IllegalStateException(
                    "XMage's card database holds only " + count + " cards (expected >= "
                            + MIN_PLAUSIBLE_CARDS + "). Refusing to start rather than let "
                            + "CardRepository rebuild it. Start the XMage server once to repopulate.");
        }
        log.info("card database ok: {} cards", count);
        checked = true;
    }

    /** The repository. {@link #require()} must have passed first. */
    public static CardRepository cards() {
        require();
        return CardRepository.instance;
    }

    private CardDb() {
    }
}
