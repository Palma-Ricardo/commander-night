package night.bridge.translate;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * {@link Html#strip} is protocol v1's plain-text gate. The load-bearing case is
 * that no XMage object UUID survives onto the wire (protocol §8): normally the
 * {@code <font object_id='…'>} tag is removed whole, but a malformed tag must
 * not leak the raw id either.
 */
class HtmlTest {

    private static final String UUID = "3d2cae7c-1111-2222-3333-84b07d939425";

    @Test
    void stripsFontTagAndItsTrailingIdFragmentLeavingOnlyTheName() {
        // MageObject.getLogName's shape (ObjectLink javadoc): the tag carries the
        // full UUID, and the "[3d2]" after it is that UUID's first three hex chars.
        String html = "<font color='#B0C4DE' object_id='" + UUID + "'>Mountain</font> [3d2]";
        assertEquals("Mountain", Html.strip(html));
    }

    @Test
    void removesUuidFromAMalformedUnclosedTag() {
        // No '>' — the tag stripper can't match it, so the id would ride through.
        String html = "Pay {1} <font object_id='" + UUID + "' Life from the Loam";
        assertFalse(Html.strip(html).contains(UUID), "raw UUID leaked to player text");
    }

    @Test
    void removesABareUuidAnywhereInText() {
        assertEquals("some card", Html.strip("some " + UUID + " card"));
    }

    @Test
    void removesTheShortIdFragmentMidText() {
        // "Temple of Deceit [5ad] enters" — the fragment rides every log name and
        // is displayed everywhere prompt/log/rules text goes; it must not survive.
        assertEquals("Temple of Deceit enters the battlefield",
                Html.strip("Temple of Deceit [5ad] enters the battlefield"));
    }

    @Test
    void removesTheShortIdFragmentAppendedToAName() {
        assertEquals("Life from the Loam", Html.strip("Life from the Loam [4fb]"));
    }

    @Test
    void leavesAFourCharBracketTokenAlone() {
        // Exactly three hex digits is the id fragment; longer bracketed tokens
        // (a set annotation, a deck-line marker) are not touched.
        assertEquals("card [MKC] here", Html.strip("card [MKC] here"));
    }

    @Test
    void leavesOrdinaryTextUntouched() {
        assertEquals("Pay {1}{G}", Html.strip("Pay {1}{G}"));
    }
}
