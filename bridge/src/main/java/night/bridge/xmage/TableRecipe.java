package night.bridge.xmage;

import mage.cards.decks.DeckCardLists;
import mage.constants.MultiplayerAttackOption;
import mage.constants.RangeOfInfluence;
import mage.game.match.MatchOptions;
import mage.players.PlayerType;
import mage.view.TableView;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.UUID;

/**
 * The table setup (design §9): create a Commander FFA table, seat every player
 * through their own session as {@link PlayerType#HUMAN}, start the match. Both
 * real humans and bridge-hosted AI seats are ordinary HUMAN sessions here — the
 * AI's decisions are made in-JVM by an {@code AiSeatDriver}, not by XMage's
 * server-side {@code COMPUTER_MAD}. Time limit is left untouched — the default is
 * {@code MatchTimeLimit.NONE}, i.e. untimed (design §1).
 *
 * <p>Failures throw {@link RecipeException} carrying the step name; the
 * caller maps it to {@code error LOBBY_STATE} and the lobby stays joinable.
 */
public final class TableRecipe {

    private static final Logger log = LoggerFactory.getLogger(TableRecipe.class);

    static final String GAME_TYPE = "Commander Free For All";
    static final String DECK_TYPE = "Variant Magic - Commander";

    public record HumanSeat(SeatSession session, DeckCardLists deck) {
    }

    public static class RecipeException extends RuntimeException {
        public RecipeException(String step) {
            super(step);
        }
    }

    /** Runs the whole recipe; returns the table id. Every seat joins as HUMAN, in list order. */
    public static UUID createAndStart(String tableName, List<HumanSeat> humans) {
        SeatSession host = humans.getFirst().session();

        UUID roomId = host.session().getMainRoomId();
        if (roomId == null) {
            throw new RecipeException("getMainRoomId");
        }

        MatchOptions options = new MatchOptions(tableName, GAME_TYPE, false);
        for (int i = 0; i < humans.size(); i++) {
            options.getPlayerTypes().add(PlayerType.HUMAN);
        }
        options.setDeckType(DECK_TYPE);
        options.setLimited(false);
        options.setAttackOption(MultiplayerAttackOption.MULTIPLE);
        options.setRange(RangeOfInfluence.ALL);
        options.setWinsNeeded(1);
        // Every table is all-human to XMage now (bridge-hosted AI seats are HUMAN
        // sessions), so the rollback (protocol §9 requestRollback) that friends'
        // night wants is always available: there is no COMPUTER_MAD simulation whose
        // per-turn state copy (GameImpl.saveRollBackGameState) it would burden. The
        // brain answers any rollback-approval playerRequest with its first-option rule.
        options.setRollbackTurnsAllowed(true);

        TableView table = host.session().createTable(roomId, options);
        if (table == null) {
            throw new RecipeException("createTable");
        }
        UUID tableId = table.getTableId();
        log.info("table {} created in room {}", tableId, roomId);

        for (HumanSeat seat : humans) {
            if (!seat.session().session().joinTable(roomId, tableId, seat.session().username(),
                    PlayerType.HUMAN, 1, seat.deck(), "")) {
                throw new RecipeException("joinTable " + seat.session().username());
            }
        }
        if (!host.session().startMatch(roomId, tableId)) {
            throw new RecipeException("startMatch");
        }
        log.info("match started on table {}", tableId);
        return tableId;
    }

    private TableRecipe() {
    }
}
