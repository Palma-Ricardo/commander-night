package night.bridge.net;

import night.bridge.proto.Ack;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;

class IdemCacheTest {

    private final IdemCache cache = new IdemCache();

    @Test
    void firstSightProceedsDuplicateInFlightDropsCompletedReplays() {
        assertInstanceOf(IdemCache.Check.Proceed.class, cache.check("a"));
        assertInstanceOf(IdemCache.Check.InFlight.class, cache.check("a"));
        Ack ack = new Ack("a");
        cache.complete("a", ack);
        IdemCache.Check.Replay replay =
                assertInstanceOf(IdemCache.Check.Replay.class, cache.check("a"));
        assertEquals(ack, replay.reply());
    }

    @Test
    void distinctIdsAreIndependent() {
        assertInstanceOf(IdemCache.Check.Proceed.class, cache.check("a"));
        assertInstanceOf(IdemCache.Check.Proceed.class, cache.check("b"));
        cache.complete("a", new Ack("a"));
        assertInstanceOf(IdemCache.Check.Replay.class, cache.check("a"));
        assertInstanceOf(IdemCache.Check.InFlight.class, cache.check("b"));
    }

    @Test
    void oldestRepliesEvictAtCapacity() {
        for (int i = 0; i < IdemCache.CAPACITY + 1; i++) {
            String id = "c" + i;
            cache.check(id);
            cache.complete(id, new Ack(id));
        }
        // c0 fell off the LRU: a very late retry re-executes (accepted trade-off)
        assertInstanceOf(IdemCache.Check.Proceed.class, cache.check("c0"));
        // the newest is still replayable
        assertInstanceOf(IdemCache.Check.Replay.class, cache.check("c" + IdemCache.CAPACITY));
    }
}
