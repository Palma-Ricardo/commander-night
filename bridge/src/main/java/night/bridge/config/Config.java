package night.bridge.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Bridge configuration, loaded from a single YAML file (design §11).
 * Every key is optional; absent keys take the documented default, unknown
 * keys are rejected so a typo can't silently fall back to a default.
 */
public record Config(
        String bind,
        Xmage xmage,
        int keyframeEvery,
        LogBackfill logBackfill,
        boolean callbackTap,
        String sampleDecksDir) {

    public record Xmage(String host, int port) {
    }

    public record LogBackfill(int buffer, int send) {
    }

    public static final Config DEFAULTS = new Config(
            "127.0.0.1:8484",
            new Xmage("127.0.0.1", 17171),
            100,
            new LogBackfill(200, 50),
            false,
            "vendor/xmage-dist/xmage/mage-client/sample-decks/Commander");

    private static final ObjectMapper YAML = new ObjectMapper(new YAMLFactory());

    public static Config load(Path file) {
        String text;
        try {
            text = Files.readString(file);
        } catch (IOException e) {
            throw new IllegalArgumentException("cannot read config file " + file + ": " + e.getMessage(), e);
        }
        if (text.isBlank()) {
            return DEFAULTS;
        }
        Raw raw;
        try {
            raw = YAML.readValue(text, Raw.class);
        } catch (UnrecognizedPropertyException e) {
            throw new IllegalArgumentException(
                    "unknown config key '" + e.getPropertyName() + "' in " + file, e);
        } catch (IOException e) {
            throw new IllegalArgumentException("malformed config file " + file + ": " + e.getMessage(), e);
        }
        return merge(raw).validate();
    }

    private static Config merge(Raw raw) {
        Raw.RawXmage x = raw.xmage != null ? raw.xmage : new Raw.RawXmage();
        Raw.RawLogBackfill lb = raw.logBackfill != null ? raw.logBackfill : new Raw.RawLogBackfill();
        return new Config(
                raw.bind != null ? raw.bind : DEFAULTS.bind,
                new Xmage(
                        x.host != null ? x.host : DEFAULTS.xmage.host,
                        x.port != null ? x.port : DEFAULTS.xmage.port),
                raw.keyframeEvery != null ? raw.keyframeEvery : DEFAULTS.keyframeEvery,
                new LogBackfill(
                        lb.buffer != null ? lb.buffer : DEFAULTS.logBackfill.buffer,
                        lb.send != null ? lb.send : DEFAULTS.logBackfill.send),
                raw.callbackTap != null ? raw.callbackTap : DEFAULTS.callbackTap,
                raw.sampleDecksDir != null ? raw.sampleDecksDir : DEFAULTS.sampleDecksDir);
    }

    private Config validate() {
        bindPort(); // throws on a malformed bind
        require(xmage.port >= 1 && xmage.port <= 65535, "xmage.port out of range: " + xmage.port);
        require(keyframeEvery >= 1, "keyframeEvery must be >= 1: " + keyframeEvery);
        require(logBackfill.buffer >= 1, "logBackfill.buffer must be >= 1: " + logBackfill.buffer);
        require(logBackfill.send >= 0 && logBackfill.send <= logBackfill.buffer,
                "logBackfill.send must be between 0 and logBackfill.buffer: " + logBackfill.send);
        return this;
    }

    private static void require(boolean ok, String message) {
        if (!ok) {
            throw new IllegalArgumentException(message);
        }
    }

    public String bindHost() {
        return bind.substring(0, splitBind());
    }

    public int bindPort() {
        String portPart = bind.substring(splitBind() + 1);
        int port;
        try {
            port = Integer.parseInt(portPart);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("bind must be host:port, got '" + bind + "'");
        }
        require(port >= 1 && port <= 65535, "bind port out of range: " + bind);
        return port;
    }

    private int splitBind() {
        int colon = bind.lastIndexOf(':');
        require(colon > 0 && colon < bind.length() - 1, "bind must be host:port, got '" + bind + "'");
        return colon;
    }

    /** Loose-shaped YAML view: boxed fields so "absent" is distinguishable. */
    private static final class Raw {
        public String bind;
        public RawXmage xmage;
        public Integer keyframeEvery;
        public RawLogBackfill logBackfill;
        public Boolean callbackTap;
        public String sampleDecksDir;

        static final class RawXmage {
            public String host;
            public Integer port;
        }

        static final class RawLogBackfill {
            public Integer buffer;
            public Integer send;
        }
    }
}
