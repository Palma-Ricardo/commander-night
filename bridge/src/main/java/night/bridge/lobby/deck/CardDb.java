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
 * server's card database is not a failure we are willing to risk.
 *
 * <p><b>Two checks, not one.</b> {@link #require()} runs a plain JDBC read to
 * confirm the table is intact <em>before</em> anything touches
 * {@code CardRepository} — but that alone cannot see a drop caused by
 * {@code CardRepository}'s own constructor, since the very first access to
 * {@code CardRepository.instance} is what runs that constructor. So
 * {@link #cards()} re-runs the same count check once, immediately after that
 * first access, and throws if the table came back missing or reduced. Startup
 * (and first import) aborts rather than letting either check's failure be
 * treated as something to "repair". This second check runs exactly once —
 * {@code cards()} is called per deck line during import, so a JDBC round trip
 * on every call would be a real cost, not just a formality.
 */
public final class CardDb {

    private static final Logger log = LoggerFactory.getLogger(CardDb.class);

    /** XMage 1.4.60 ships ~100k rows; anything near-empty means a wiped or half-built db. */
    private static final int MIN_PLAUSIBLE_CARDS = 20_000;

    private static final String URL = "jdbc:h2:file:./db/cards.h2;AUTO_SERVER=TRUE;IGNORECASE=TRUE";

    private static boolean checked;
    private static boolean cardsVerified;

    /**
     * Verifies the card database is present and populated, before anything
     * touches {@code CardRepository}. Idempotent; throws
     * {@link IllegalStateException} with an operator-actionable message
     * otherwise.
     */
    public static synchronized void require() {
        if (checked) {
            return;
        }
        int count = countCards();
        if (count < MIN_PLAUSIBLE_CARDS) {
            throw new IllegalStateException(
                    "XMage's card database holds only " + count + " cards (expected >= "
                            + MIN_PLAUSIBLE_CARDS + "). Refusing to start rather than let "
                            + "CardRepository rebuild it. Start the XMage server once to repopulate.");
        }
        log.info("card database ok: {} cards", count);
        checked = true;
    }

    /**
     * The repository. Runs {@link #require()} first. On the very first call
     * only, also re-verifies the count immediately after the first touch of
     * {@code CardRepository.instance} — that touch is what runs
     * {@code CardRepository}'s constructor and its own independent drop
     * logic, which {@link #require()} cannot see coming.
     */
    public static synchronized CardRepository cards() {
        require();
        CardRepository instance = CardRepository.instance;
        if (!cardsVerified) {
            int count = countCards();
            if (count < MIN_PLAUSIBLE_CARDS) {
                throw new IllegalStateException(
                        "CardRepository's constructor just wiped the card table down to " + count
                                + " cards (expected >= " + MIN_PLAUSIBLE_CARDS + "). This fires when the "
                                + "Build-Time manifest attribute of mage-client's mage-*.jar diverges from "
                                + "the game server's copy of the same jar — most likely a dist upgrade that "
                                + "replaced one copy but not the other. CardRepository treats that mismatch "
                                + "as a signal to rebuild and drops its table instead. Start the XMage "
                                + "server once to repopulate it.");
            }
            cardsVerified = true;
        }
        return instance;
    }

    private static int countCards() {
        try (Connection c = DriverManager.getConnection(URL, "", "");
             Statement s = c.createStatement();
             ResultSet rs = s.executeQuery("SELECT count(*) FROM card")) {
            rs.next();
            return rs.getInt(1);
        } catch (SQLException e) {
            throw new IllegalStateException(
                    "cannot read XMage's card database at ./db/cards.h2 — deck import needs it. "
                            + "Expected a symlink 'db' pointing at the dist's mage-server/db directory. "
                            + "Cause: " + e.getMessage(), e);
        }
    }

    private CardDb() {
    }
}
