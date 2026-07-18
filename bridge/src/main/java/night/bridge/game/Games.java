package night.bridge.game;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** gameId → coordinator, for routing game.* commands (design §4). */
public final class Games {

    private final Map<String, GameCoordinator> byId = new ConcurrentHashMap<>();

    void register(String gameId, GameCoordinator coordinator) {
        byId.put(gameId, coordinator);
    }

    /** Post-game teardown: the id stops routing (UNKNOWN_GAME / RESUME_FAILED). */
    void unregister(String gameId) {
        byId.remove(gameId);
    }

    public GameCoordinator byId(String gameId) {
        return byId.get(gameId);
    }
}
