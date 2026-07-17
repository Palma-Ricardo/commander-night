package night.bridge.net;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import night.bridge.proto.Ack;
import night.bridge.proto.ClientMsg;
import night.bridge.proto.Err;
import night.bridge.proto.ErrorCode;
import night.bridge.proto.Hello;
import night.bridge.proto.Msg;
import night.bridge.proto.Role;
import night.bridge.proto.ServerMsg;
import night.bridge.proto.Welcome;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CodecTest {

    private final Codec codec = new Codec();
    private final ObjectMapper json = new ObjectMapper();

    private Codec.Decoded.Ok ok(String frame) {
        return assertInstanceOf(Codec.Decoded.Ok.class, codec.decode(frame));
    }

    private Codec.Decoded.Bad bad(String frame) {
        return assertInstanceOf(Codec.Decoded.Bad.class, codec.decode(frame));
    }

    private JsonNode tree(String s) throws Exception {
        return json.readTree(s);
    }

    // ---- decoding ----

    @Test
    void minimalHelloDecodes() {
        Hello h = (Hello) ok("""
                {"t":"session.hello","id":"c1","v":1}""").msg();
        assertEquals("c1", h.id());
        assertEquals(1, h.v());
        assertNull(h.token());
        assertNull(h.resume());
        assertNull(h.stateMode());
    }

    @Test
    void fullHelloDecodes() {
        Hello h = (Hello) ok("""
                {"t":"session.hello","id":"c2","v":1,"token":"tok123",
                 "resume":{"gameId":"g1","lastSeq":812},"stateMode":"keyframes"}""").msg();
        assertEquals("tok123", h.token());
        assertEquals(new Hello.Resume("g1", 812), h.resume());
        assertEquals("keyframes", h.stateMode());
    }

    @Test
    void unknownFieldsAreIgnored() {
        // §3: unknown fields MUST be ignored, at every nesting level.
        Hello h = (Hello) ok("""
                {"t":"session.hello","id":"c1","v":1,"futureField":{"x":1},
                 "resume":{"gameId":"g1","lastSeq":1,"alsoFuture":true}}""").msg();
        assertEquals("c1", h.id());
    }

    @Test
    void unknownTypeIsIgnoredNotAnError() {
        // §3 forward compatibility: unknown 't' → dropped, not BAD_MESSAGE.
        Codec.Decoded.Ignored ignored = assertInstanceOf(Codec.Decoded.Ignored.class,
                codec.decode("""
                        {"t":"future.command","id":"c9","payload":42}"""));
        assertEquals("future.command", ignored.t());
    }

    @Test
    void malformedJsonIsBad() {
        assertNull(bad("{oops").re());
        assertNull(bad("").re());
    }

    @Test
    void nonObjectFramesAreBad() {
        bad("[1,2,3]");
        bad("\"hello\"");
        bad("42");
    }

    @Test
    void missingDiscriminatorIsBad() {
        // The command id is still readable → the error can reference it.
        assertEquals("c1", bad("""
                {"id":"c1","v":1}""").re());
        bad("""
                {"t":5,"id":"c1"}""");
    }

    @Test
    void missingRequiredFieldsAreBad() {
        assertEquals("c1", bad("""
                {"t":"session.hello","id":"c1"}""").re());          // no v
        assertNull(bad("""
                {"t":"session.hello","v":1}""").re());               // no id
        assertEquals("c1", bad("""
                {"t":"session.hello","id":"c1","v":1,"resume":{"lastSeq":4}}""").re()); // resume w/o gameId
    }

    @Test
    void wrongFieldTypeIsBad() {
        assertEquals("c1", bad("""
                {"t":"session.hello","id":"c1","v":"one"}""").re());
    }

    @Test
    void serverTypesFromClientAreBad() {
        Codec.Decoded.Bad b = bad("""
                {"t":"ack","re":"x"}""");
        assertTrue(b.reason().contains("not a client command"), b.reason());
        bad("""
                {"t":"session.welcome","re":"c1","v":1,"userId":"u","role":"player","resumed":false}""");
    }

    // ---- encoding ----

    @Test
    void freshWelcomeCarriesToken() throws Exception {
        JsonNode n = tree(codec.encode(new Welcome("c1", 1, "user-1", "tok-abc", Role.PLAYER, false)));
        assertEquals("session.welcome", n.get("t").asText());
        assertEquals("c1", n.get("re").asText());
        assertEquals(1, n.get("v").asInt());
        assertEquals("user-1", n.get("userId").asText());
        assertEquals("tok-abc", n.get("token").asText());
        assertEquals("player", n.get("role").asText());
        assertFalse(n.get("resumed").asBoolean());
    }

    @Test
    void rebindWelcomeOmitsToken() throws Exception {
        JsonNode n = tree(codec.encode(new Welcome("c1", 1, "user-1", null, Role.PLAYER, false)));
        assertFalse(n.has("token"));
    }

    @Test
    void errOmitsAbsentOptionals() throws Exception {
        JsonNode n = tree(codec.encode(Err.of(ErrorCode.BAD_MESSAGE, "nope")));
        assertEquals("error", n.get("t").asText());
        assertEquals("BAD_MESSAGE", n.get("code").asText());
        assertEquals("nope", n.get("message").asText());
        assertFalse(n.has("re"));
        assertFalse(n.has("fatal"));

        JsonNode fatal = tree(codec.encode(Err.fatal("c3", ErrorCode.UNSUPPORTED_VERSION, "v2")));
        assertEquals("c3", fatal.get("re").asText());
        assertTrue(fatal.get("fatal").asBoolean());
    }

    @Test
    void ackEncodes() throws Exception {
        JsonNode n = tree(codec.encode(new Ack("c7")));
        assertEquals("ack", n.get("t").asText());
        assertEquals("c7", n.get("re").asText());
    }

    // ---- vocabulary integrity ----

    @Test
    void everyMessageTypeHasAWireName() {
        // The sealed hierarchy (permits) and the @JsonSubTypes table on Msg must
        // list the same concrete records, or a type silently loses its wire name.
        Set<Class<?>> sealedLeaves = Stream.of(ClientMsg.class, ServerMsg.class)
                .flatMap(i -> Arrays.stream(i.getPermittedSubclasses()))
                .collect(Collectors.toSet());
        Set<Class<?>> named = Arrays.stream(Msg.class.getAnnotation(JsonSubTypes.class).value())
                .map(JsonSubTypes.Type::value)
                .collect(Collectors.toSet());
        assertEquals(sealedLeaves, named);
    }
}
