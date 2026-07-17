package night.bridge.xmage;

import mage.constants.ManaType;
import mage.constants.PlayerAction;
import mage.remote.Session;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.UUID;

/**
 * Typed wrappers over XMage's positional answer channel (protocol §15 table).
 * Every send is logged — the answers are the half of the conversation the
 * callback tap can't see.
 */
public final class XmageAnswers {

    private static final Logger log = LoggerFactory.getLogger(XmageAnswers.class);

    private final Session session;
    private final UUID gameId;
    private final UUID playerId;

    public XmageAnswers(Session session, UUID gameId, UUID playerId) {
        this.session = session;
        this.gameId = gameId;
        this.playerId = playerId;
    }

    public void bool(boolean value) {
        log.debug("answer boolean {}", value);
        session.sendPlayerBoolean(gameId, value);
    }

    public void pick(UUID objectId) {
        log.debug("answer uuid {}", objectId);
        session.sendPlayerUUID(gameId, objectId);
    }

    public void integer(int value) {
        log.debug("answer integer {}", value);
        session.sendPlayerInteger(gameId, value);
    }

    public void text(String value) {
        log.debug("answer string {}", value);
        session.sendPlayerString(gameId, value);
    }

    public void mana(ManaType type) {
        log.debug("answer mana {}", type);
        session.sendPlayerManaType(gameId, playerId, type);
    }

    public void action(PlayerAction action) {
        log.debug("answer action {}", action);
        session.sendPlayerAction(action, gameId, null);
    }
}
