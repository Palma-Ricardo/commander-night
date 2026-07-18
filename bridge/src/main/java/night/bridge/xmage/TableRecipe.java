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
 * The spike-proven table setup (design §9): create a Commander FFA table,
 * seat the AIs through the host's session, seat each human through their own
 * session, start the match. Time limit is left untouched — the default is
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

    /** Runs the whole recipe; returns the table id. Humans seat in list order, AIs after. */
    public static UUID createAndStart(String tableName, List<HumanSeat> humans, List<DeckCardLists> aiDecks) {
        SeatSession host = humans.getFirst().session();

        UUID roomId = host.session().getMainRoomId();
        if (roomId == null) {
            throw new RecipeException("getMainRoomId");
        }

        MatchOptions options = new MatchOptions(tableName, GAME_TYPE, false);
        for (int i = 0; i < humans.size(); i++) {
            options.getPlayerTypes().add(PlayerType.HUMAN);
        }
        for (int i = 0; i < aiDecks.size(); i++) {
            options.getPlayerTypes().add(PlayerType.COMPUTER_MAD);
        }
        options.setDeckType(DECK_TYPE);
        options.setLimited(false);
        options.setAttackOption(MultiplayerAttackOption.MULTIPLE);
        options.setRange(RangeOfInfluence.ALL);
        options.setWinsNeeded(1);
        // MatchOptions defaults this to false, which left protocol §9 requestRollback
        // dead on every table until 2026-07-18. Friends' night wants the undo — but only
        // all-human tables get it: with AI seats, rollback buys nothing (auto-players
        // never roll back) while its per-turn full-state copy
        // (GameImpl.saveRollBackGameState) adds load to the fragile AI-simulation server
        // (suspected, unproven, of shortening AI games — 2026-07-18 live runs). The
        // client hides the rollback control via GameState.rollbackTurnsAllowed either way.
        options.setRollbackTurnsAllowed(aiDecks.isEmpty());

        TableView table = host.session().createTable(roomId, options);
        if (table == null) {
            throw new RecipeException("createTable");
        }
        UUID tableId = table.getTableId();
        log.info("table {} created in room {}", tableId, roomId);

        int ai = 0;
        for (DeckCardLists deck : aiDecks) {
            ai++;
            if (!host.session().joinTable(roomId, tableId, "ai_" + ai, PlayerType.COMPUTER_MAD, 5, deck, "")) {
                throw new RecipeException("joinTable ai_" + ai);
            }
        }
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
