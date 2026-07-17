package night.bridge.translate;

import java.util.regex.Pattern;

/**
 * XMage sends Swing-flavored HTML in messages, rules lines, and log entries;
 * protocol v1 is plain text (§8, §10). Tag stripping + the handful of
 * entities XMage actually emits — not a general HTML parser on purpose.
 */
public final class Html {

    private static final Pattern TAG = Pattern.compile("<[^>]*>");

    public static String strip(String html) {
        if (html == null) {
            return "";
        }
        String s = TAG.matcher(html.replace("<br>", " ").replace("<br/>", " ")).replaceAll("");
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
