package night.bridge.config;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ConfigTest {

    @TempDir
    Path dir;

    private Config load(String yaml) throws IOException {
        Path file = dir.resolve("bridge.yaml");
        Files.writeString(file, yaml);
        return Config.load(file);
    }

    @Test
    void defaultsMatchDesignDoc() {
        Config c = Config.DEFAULTS;
        assertEquals("127.0.0.1", c.bindHost());
        assertEquals(8484, c.bindPort());
        assertEquals("127.0.0.1", c.xmage().host());
        assertEquals(17171, c.xmage().port());
        assertEquals(100, c.keyframeEvery());
        assertEquals(200, c.logBackfill().buffer());
        assertEquals(50, c.logBackfill().send());
        assertFalse(c.callbackTap());
        assertEquals("vendor/xmage-dist/xmage/mage-client/sample-decks/Commander", c.sampleDecksDir());
    }

    @Test
    void emptyFileYieldsDefaults() throws IOException {
        assertEquals(Config.DEFAULTS, load(""));
    }

    @Test
    void fullFileParsesEveryKey() throws IOException {
        Config c = load("""
                bind: 0.0.0.0:9000
                xmage: { host: xmage.local, port: 18000 }
                keyframeEvery: 25
                logBackfill: { buffer: 500, send: 100 }
                callbackTap: true
                sampleDecksDir: /opt/decks
                """);
        assertEquals(new Config("0.0.0.0:9000", new Config.Xmage("xmage.local", 18000), 25,
                new Config.LogBackfill(500, 100), true, "/opt/decks"), c);
        assertEquals("0.0.0.0", c.bindHost());
        assertEquals(9000, c.bindPort());
    }

    @Test
    void partialFileKeepsDefaultsForAbsentKeys() throws IOException {
        Config c = load("""
                xmage: { port: 18000 }
                callbackTap: true
                """);
        assertEquals("127.0.0.1", c.xmage().host());
        assertEquals(18000, c.xmage().port());
        assertTrue(c.callbackTap());
        assertEquals(Config.DEFAULTS.bind(), c.bind());
        assertEquals(Config.DEFAULTS.keyframeEvery(), c.keyframeEvery());
        assertEquals(Config.DEFAULTS.logBackfill(), c.logBackfill());
    }

    @Test
    void unknownKeyIsRejected() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> load("keyframeEvry: 50"));
        assertTrue(e.getMessage().contains("keyframeEvry"), e.getMessage());
    }

    @Test
    void missingFileIsRejected() {
        assertThrows(IllegalArgumentException.class, () -> Config.load(dir.resolve("nope.yaml")));
    }

    @Test
    void malformedBindIsRejected() {
        assertThrows(IllegalArgumentException.class, () -> load("bind: just-a-host"));
        assertThrows(IllegalArgumentException.class, () -> load("bind: host:notaport"));
        assertThrows(IllegalArgumentException.class, () -> load("bind: host:99999"));
    }

    @Test
    void outOfRangeValuesAreRejected() {
        assertThrows(IllegalArgumentException.class, () -> load("keyframeEvery: 0"));
        assertThrows(IllegalArgumentException.class, () -> load("xmage: { port: 0 }"));
        assertThrows(IllegalArgumentException.class, () -> load("logBackfill: { buffer: 10, send: 20 }"));
    }
}
