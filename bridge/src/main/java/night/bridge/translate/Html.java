package night.bridge.translate;

import java.util.regex.Pattern;

/**
 * XMage sends Swing-flavored HTML in messages, rules lines, and log entries;
 * protocol v1 is plain text (§8, §10). Tag stripping + the handful of
 * entities XMage actually emits — not a general HTML parser on purpose.
 */
public final class Html {

    private static final Pattern TAG = Pattern.compile("<[^>]*>");

    /**
     * A full XMage object UUID. Object names ride in as
     * {@code <font ... object_id='<uuid>'>Name</font>} ({@link ObjectLink}), so
     * {@link #TAG} normally removes the id along with the tag. But a malformed or
     * unclosed tag — anything with no {@code >} — slips past {@code TAG} and would
     * leak the raw id into player-facing text (protocol §8 is plain text). This is
     * the belt-and-suspenders that guarantees no UUID ever survives {@code strip}
     * onto the wire. Machine ids we answer back to XMage ({@code payMana.for},
     * option ids, log refs) are lifted from the raw HTML elsewhere, never through
     * here, so removing them from display text can never break a reply.
     */
    private static final Pattern OBJECT_ID = Pattern.compile(
            "\\s*(?:object_id=')?"
            + "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
            + "'?");

    /**
     * XMage's short id fragment. {@code MageObject.getLogName()} — which names
     * every object in log lines, prompt text and rules text — renders as
     * {@code <font object_id='<uuid>'>Name</font> [5ad]}, where {@code [5ad]} is
     * the first three hex chars of that same UUID. Tag stripping leaves the
     * {@code Name [5ad]}, so the abbreviated id survives as visible text ("Temple
     * of Deceit [5ad]"); this removes it. Exactly three hex digits in brackets:
     * no Magic card name, type, or oracle line carries that, while every named
     * object does.
     */
    private static final Pattern ID_FRAGMENT = Pattern.compile("\\s*\\[[0-9a-fA-F]{3}\\]");

    public static String strip(String html) {
        if (html == null) {
            return "";
        }
        String s = TAG.matcher(html.replace("<br>", " ").replace("<br/>", " ")).replaceAll("");
        s = OBJECT_ID.matcher(s).replaceAll("");
        s = ID_FRAGMENT.matcher(s).replaceAll("");
        return s.replace("&nbsp;", " ")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&apos;", "'")
                .replace("&amp;", "&")
                .replaceAll("\\s+", " ")
                .strip();
    }

    private Html() {
    }
}
