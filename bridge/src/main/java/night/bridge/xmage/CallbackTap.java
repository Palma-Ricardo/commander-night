package night.bridge.xmage;

import mage.interfaces.callback.ClientCallback;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedOutputStream;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.ObjectOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Per-seat callback capture (design §12/§13, config {@code callbackTap}).
 * Two files per seat per game under the tap directory:
 *
 * <ul>
 * <li>{@code <label>.ser} — every {@link ClientCallback} Java-serialized
 *     <em>before</em> {@code decompressData()}, i.e. byte-faithful to what
 *     JBoss Remoting delivered. This is the golden-fixture source: fixtures
 *     deserialize against the same pinned jars and replay through the
 *     translators. Read back with repeated {@code ObjectInputStream.readObject}
 *     until EOF.</li>
 * <li>{@code <label>.jsonl} — one index line per callback (ordinal, timestamp,
 *     method, messageId) for finding the interesting ones without
 *     deserializing anything.</li>
 * </ul>
 *
 * Failure policy: capture must never hurt the game path. Any IO error logs a
 * WARN and the tap goes inert. {@link #tap} is called from XMage's callback
 * threads (up to 10) and synchronizes internally; the payload is still the
 * compressed wire object, so serialization is cheap.
 */
public final class CallbackTap implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(CallbackTap.class);

    private final ObjectOutputStream ser;
    private final BufferedWriter index;
    private long ordinal;
    private boolean broken;

    private CallbackTap(ObjectOutputStream ser, BufferedWriter index) {
        this.ser = ser;
        this.index = index;
    }

    /** Returns null (tap disabled for this seat) when the files cannot be created. */
    public static CallbackTap open(Path dir, String label) {
        try {
            Files.createDirectories(dir);
            ObjectOutputStream ser = new ObjectOutputStream(new BufferedOutputStream(
                    Files.newOutputStream(dir.resolve(label + ".ser"))));
            BufferedWriter index = Files.newBufferedWriter(dir.resolve(label + ".jsonl"));
            log.info("callback tap open: {}/{}.ser", dir, label);
            return new CallbackTap(ser, index);
        } catch (IOException e) {
            log.warn("callback tap unavailable for {}: {}", label, e.toString());
            return null;
        }
    }

    public synchronized void tap(ClientCallback callback) {
        if (broken) {
            return;
        }
        try {
            ser.writeObject(callback);
            ser.reset();    // don't let the handle table pin every callback in memory
            index.write("{\"n\":" + ordinal++
                    + ",\"ts\":" + System.currentTimeMillis()
                    + ",\"method\":\"" + callback.getMethod() + '"'
                    + ",\"messageId\":" + callback.getMessageId() + "}\n");
        } catch (IOException e) {
            broken = true;
            log.warn("callback tap failed (capture stops, game unaffected): {}", e.toString());
        }
    }

    @Override
    public synchronized void close() {
        try {
            ser.close();
            index.close();
        } catch (IOException e) {
            log.debug("callback tap close: {}", e.toString());
        }
    }
}
