package night.bridge.net;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import night.bridge.proto.Ack;
import night.bridge.proto.Err;
import night.bridge.proto.ErrorCode;
import night.bridge.proto.Hello;
import night.bridge.proto.Role;
import night.bridge.proto.ServerMsg;
import night.bridge.proto.Welcome;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Conformance corpus (design §13): the committed samples under
 * docs/protocol/samples/ are the agreement between this bridge and the future
 * TS client. Client → server samples must decode; server → client samples
 * must be exactly reproducible from our message types (tree equality — key
 * order is not significant).
 */
class ProtocolSamplesTest {

    // Surefire runs with cwd = bridge/; the corpus lives beside the spec.
    private static final Path SAMPLES = Path.of("..", "docs", "protocol", "samples");

    private final Codec codec = new Codec();
    private final ObjectMapper json = new ObjectMapper();

    private JsonNode sample(String name) throws Exception {
        Path file = SAMPLES.resolve(name);
        assertTrue(Files.exists(file), "missing corpus sample " + file.toAbsolutePath().normalize());
        return json.readTree(Files.readString(file));
    }

    private void assertProduces(String sampleName, ServerMsg msg) throws Exception {
        assertEquals(sample(sampleName), json.readTree(codec.encode(msg)), sampleName);
    }

    @Test
    void helloFreshDecodes() throws Exception {
        Codec.Decoded.Ok ok = assertInstanceOf(Codec.Decoded.Ok.class,
                codec.decode(sample("session.hello.fresh.json").toString()));
        assertEquals(new Hello("c1", 1, null, null, null), ok.msg());
    }

    @Test
    void helloResumeDecodes() throws Exception {
        Codec.Decoded.Ok ok = assertInstanceOf(Codec.Decoded.Ok.class,
                codec.decode(sample("session.hello.resume.json").toString()));
        Hello h = (Hello) ok.msg();
        assertEquals("kZ1xW3vJqL8mN5aPbT9cDg", h.token());
        assertEquals(new Hello.Resume("3f2a9d1e-6c47-4b2e-9a10-8e5d21f7b0c4", 812), h.resume());
    }

    @Test
    void welcomeSamplesAreReproducible() throws Exception {
        assertProduces("session.welcome.fresh.json",
                new Welcome("c1", 1, "7d4c1b2a-9e8f-4a3b-b6c5-0d1e2f3a4b5c",
                        "kZ1xW3vJqL8mN5aPbT9cDg", Role.PLAYER, false));
        assertProduces("session.welcome.resumed.json",
                new Welcome("c2", 1, "7d4c1b2a-9e8f-4a3b-b6c5-0d1e2f3a4b5c",
                        null, Role.PLAYER, true));
    }

    @Test
    void ackSampleIsReproducible() throws Exception {
        assertProduces("ack.json", new Ack("c3"));
    }

    @Test
    void errorSamplesAreReproducible() throws Exception {
        assertProduces("error.json",
                Err.re("c4", ErrorCode.BAD_MESSAGE, "missing 't' discriminator"));
        assertProduces("error.fatal.json",
                Err.fatal("c5", ErrorCode.UNSUPPORTED_VERSION,
                        "protocol v2 is not supported; this bridge speaks v1"));
    }
}
