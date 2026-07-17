package night.bridge;

import night.bridge.config.Config;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * night-bridge entry point: load configuration, wire subsystems, run until
 * shut down. M0 stops after the config stage — the WS endpoint arrives in M1.
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
        log.info("M0 scaffold — nothing to serve yet (WS endpoint lands in M1), exiting");
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
