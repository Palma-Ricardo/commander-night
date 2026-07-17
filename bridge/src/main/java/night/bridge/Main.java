package night.bridge;

import io.javalin.Javalin;
import night.bridge.config.Config;
import night.bridge.game.Games;
import night.bridge.lobby.LobbyService;
import night.bridge.net.Codec;
import night.bridge.net.SessionRegistry;
import night.bridge.net.WsEndpoint;
import night.bridge.xmage.XmageGateway;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * night-bridge entry point: load configuration, wire subsystems, run until
 * shut down. M2 serves lobby → live game against a local XMage server
 * (keyframes-only state sync; priority/confirm/target/mana prompts).
 */
public final class Main {

    private static final Logger log = LoggerFactory.getLogger(Main.class);

    public static void main(String[] args) {
        Config config;
        try {
            config = loadConfig(args);
        } catch (IllegalArgumentException e) {
            log.error("config error: {}", e.getMessage());
            System.exit(1);
            return;
        }
        log.info("night-bridge starting: bind={} xmage={}:{} keyframeEvery={} callbackTap={}",
                config.bind(), config.xmage().host(), config.xmage().port(),
                config.keyframeEvery(), config.callbackTap());

        SessionRegistry registry = new SessionRegistry();
        XmageGateway gateway = new XmageGateway(config);
        Games games = new Games();
        LobbyService lobby = new LobbyService(registry, gateway, games, config);
        Javalin app = new WsEndpoint(new Codec(), registry, lobby, games, gateway::health).buildApp();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            log.info("shutting down");
            app.stop();
            lobby.close();
            gateway.close();
            registry.close();
        }, "shutdown"));
        app.start(config.bindHost(), config.bindPort());
        log.info("night-bridge listening on {} (WS /ws, GET /healthz)", config.bind());
    }

    /** Optional single argument: path to the YAML config. Otherwise ./bridge.yaml if present, else defaults. */
    private static Config loadConfig(String[] args) {
        if (args.length > 1) {
            throw new IllegalArgumentException("usage: night-bridge [config.yaml]");
        }
        if (args.length == 1) {
            return Config.load(Path.of(args[0]));
        }
        Path conventional = Path.of("bridge.yaml");
        if (Files.exists(conventional)) {
            return Config.load(conventional);
        }
        log.info("no config file given and no ./bridge.yaml — using defaults");
        return Config.DEFAULTS;
    }

    private Main() {
    }
}
