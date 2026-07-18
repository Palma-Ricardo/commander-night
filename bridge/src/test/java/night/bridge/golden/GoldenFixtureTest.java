package night.bridge.golden;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import mage.interfaces.callback.ClientCallback;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Golden-fixture tier (design §13): real captured callbacks, deserialized
 * against the same pinned 1.4.60 jars the bridge compiles with, replayed
 * through ViewTranslator/PromptTranslator, asserted against committed golden
 * JSON. On an XMage upgrade, regenerate and read the golden diff — it shows
 * exactly what the upgrade changed in our wire output:
 *
 * <pre>mvn test -Dtest=GoldenFixtureTest -Dgolden.regen=true</pre>
 *
 * Fixture pairs live in {@code src/test/resources/fixtures/}: {@code <name>.ser}
 * (one pre-decompression ClientCallback, selected from a live game's tap by
 * {@link FixtureSelectMain}) and {@code <name>.golden.json} (the wire messages
 * the callback translates to, state-before-prompt per protocol §7).
 */
class GoldenFixtureTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final boolean REGEN = Boolean.getBoolean("golden.regen");

    @TestFactory
    Stream<DynamicTest> goldens() throws Exception {
        assertTrue(Files.isDirectory(GoldenFixtures.DIR),
                "fixture directory missing: " + GoldenFixtures.DIR.toAbsolutePath().normalize()
                        + " — capture a live game (tap) and run FixtureSelectMain");
        List<Path> fixtures;
        try (Stream<Path> files = Files.list(GoldenFixtures.DIR)) {
            fixtures = files.filter(f -> f.getFileName().toString().endsWith(".ser"))
                    .sorted()
                    .toList();
        }
        assertTrue(!fixtures.isEmpty(), "no .ser fixtures in " + GoldenFixtures.DIR);
        return fixtures.stream().map(f -> DynamicTest.dynamicTest(name(f), () -> check(f)));
    }

    private static String name(Path fixture) {
        String base = fixture.getFileName().toString();
        return base.substring(0, base.length() - ".ser".length());
    }

    private static void check(Path fixture) throws Exception {
        ClientCallback cb = GoldenFixtures.readFixture(fixture);
        JsonNode actual = GoldenFixtures.route(cb);
        Path goldenFile = fixture.resolveSibling(name(fixture) + ".golden.json");
        if (REGEN) {
            Files.writeString(goldenFile, actual.toPrettyString() + "\n");
            return;
        }
        assertTrue(Files.exists(goldenFile),
                "missing golden " + goldenFile + " — run with -Dgolden.regen=true and commit");
        JsonNode golden = JSON.readTree(Files.readString(goldenFile));
        assertEquals(golden, actual, () ->
                "golden drift for " + name(fixture) + " (method " + cb.getMethod() + ") — if the "
                        + "change is intended, regenerate with -Dgolden.regen=true and review the diff");
    }
}
