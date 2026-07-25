package night.bridge.translate;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The 1.4.60 object-link scrape behind {@code payMana.for} and {@code distribute} rows. */
class ObjectLinkTest {

    private static final String LINK =
            "<font color='#B0C4DE' object_id='3d2cae7c-9785-47b6-a636-84b07d939425'>Mountain</font> [3d2]";

    @Test
    void readsTheObjectIdOutOfALogName() {
        assertEquals("3d2cae7c-9785-47b6-a636-84b07d939425", ObjectLink.sole(LINK));
    }

    @Test
    void twoLinksAreAmbiguousAndYieldNothing() {
        assertNull(ObjectLink.sole(LINK + " and " + LINK));
    }

    @Test
    void textWithoutALinkYieldsNothing() {
        assertNull(ObjectLink.sole("Pay {2}"));
        assertNull(ObjectLink.sole(null));
        assertNull(ObjectLink.sole(""));
    }

    @Test
    void theCanaryFiresOnlyForANamedObjectWithNoParseableLink() {
        // Any font-rendered name with no link at all. In payMana — the only caller —
        // the sole font-rendered name is the paying object, so this is the drift signal:
        // 1.4.60 always writes object_id there (spike: 1114/1114 asks).
        assertTrue(ObjectLink.canaryMissed("<font color='#20B2AA'>Mountain</font>"));
        assertFalse(ObjectLink.canaryMissed(LINK), "a parsed link is not drift");
        assertFalse(ObjectLink.canaryMissed(LINK + LINK), "two links are ambiguity, not drift");
        assertFalse(ObjectLink.canaryMissed("Pay {2}"), "no object named at all");
    }
}
