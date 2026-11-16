package night.bridge.live;

import io.javalin.Javalin;
import night.bridge.config.Config;
import night.bridge.game.Games;
import night.bridge.live.LiveHarness.Client;
import night.bridge.lobby.LobbyService;
import night.bridge.net.Codec;
import night.bridge.net.SessionRegistry;
import night.bridge.net.WsEndpoint;
import night.bridge.xmage.XmageGateway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.concurrent.TimeUnit;

import static night.bridge.live.LiveHarness.xmageUp;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The M3 exit criterion as a test (design §13 live tier, §14): a raw-WS
 * client plays a full Commander game against 3 AIs through the whole bridge
 * stack — in patch mode — auto-answering every prompt, while auditing
 * protocol invariants on every received frame:
 *
 * <ul>
 *   <li>game.* event seq is gapless and strictly ordered per seat;</li>
 *   <li>every patch's {@code base} matches the last applied state event, its
 *       ops are add/remove/replace only, and it applies cleanly onto the
 *       running tree;</li>
 *   <li>a mid-game {@code game.resync} keyframe equals the patch-applied
 *       tree byte-for-byte (the §7 apply-and-compare);</li>
 *   <li>at most one prompt pending — every prompt is promptDone'd before the next;</li>
 *   <li>required target selections are answered whole-set ({@code objects}),
 *       exercising the §8 replay live;</li>
 *   <li>combat declaration fires and completes: the seat plays lands, casts,
 *       and attacks with one creature per combat, so `priority`+`combat`
 *       toggle → defender pick → done round-trips run in every game (the
 *       pacifist M3 auto-player never held a creature, and XMage skips the
 *       ask entirely for a creatureless seat — the blind spot that hid the
 *       combat gap through 8/8 validation games);</li>
 *   <li>no error frames beyond benign PROMPT_STALE races;</li>
 *   <li>the game reaches game.over with a final keyframe first, and total
 *       game.* wire bytes stay within the §7 budget.</li>
 * </ul>
 *
 * The driver and its exit assertions live in
 * {@link LiveHarness#playFullGame(Client, java.nio.file.Path)}; this test supplies
 * the in-process stack it runs against, and plays {@link LiveHarness#AGGRO_DECK}
 * so the combat assertion has creatures to declare with. Requires a local XMage
 * server on 17171 (skipped otherwise): run {@code mvn -Plive test}. This doubles
 * as the JDK-26 session-layer soak.
 */
@Tag("live")
class LiveGameTest {

    @Test
    @Timeout(value = 20, unit = TimeUnit.MINUTES)
    void fullGameAgainstThreeAis() throws Exception {
        assumeTrue(xmageUp(), "local XMage server on 17171 required (vendor/xmage-dist)");

        // callbackTap on: every live run captures golden-fixture source material
        // under logs/tap/ (design §13; curate with FixtureSelectMain)
        Config config = new Config("127.0.0.1:0", new Config.Xmage("127.0.0.1", 17171),
                100, new Config.LogBackfill(200, 50), true,
                "../vendor/xmage-dist/xmage/mage-client/sample-decks/Commander", 900);
        Games games = new Games();
        SessionRegistry registry = new SessionRegistry(games);
        XmageGateway gateway = new XmageGateway(config);
        LobbyService lobby = new LobbyService(registry, gateway, games, config);
        Javalin app = new WsEndpoint(new Codec(), registry, lobby, games, gateway::health).buildApp();
        app.start("127.0.0.1", 0);
        try {
            LiveHarness.playFullGame(Client.connect(app.port(), "solo"), LiveHarness.AGGRO_DECK);
        } finally {
            app.stop();
            lobby.close();
            gateway.close();
            registry.close();
        }
    }
}
