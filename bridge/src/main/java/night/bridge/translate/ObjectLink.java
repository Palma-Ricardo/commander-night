package night.bridge.translate;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Object links inside XMage's presentation HTML (design §7, protocol §8 —
 * {@code payMana.for}, {@code distribute.among[].objectId}). Wherever 1.4.60
 * names a game object in text meant for a human, it writes the name through
 * {@code GameLog.getColoredObjectIdName}, which carries the object's <em>full
 * UUID</em> in an attribute the Swing client uses for card popups:
 *
 * <pre>
 * &lt;font color='#B0C4DE' object_id='3d2cae7c-…-84b07d939425'&gt;Mountain&lt;/font&gt; [3d2]
 * </pre>
 *
 * That is the only machine-readable identity in several asks that otherwise
 * carry none — the {@code GAME_PLAY_MANA} ask's prompt text
 * ({@code ManaUtil.addSpecialManaPayAbilities} appends
 * {@code baseObject.getLogName()} inside a {@code <div>}), and
 * {@code MultiAmountMessage} rows ({@code CombatGroup} builds them as
 * {@code "<logName>, P/T: p/t"}).
 *
 * <p>Same contract as the commander-damage scrape: pinned to 1.4.60's strings,
 * canary WARN on drift, and the field simply goes <b>absent</b> when the scrape
 * misses. {@link #sole} deliberately returns null when a text carries more than
 * one link — an ambiguous anchor is worse than none.
 */
public final class ObjectLink {

    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(ObjectLink.class);

    /** GameLog.getColoredObjectIdName's attribute, pinned to 1.4.60. */
    private static final Pattern OBJECT_ID =
            Pattern.compile("object_id='([0-9a-fA-F-]{36})'");

    /** Marks text that <em>should</em> carry a link: an object name rendered as a font tag. */
    private static final String CANARY = "<font";

    /**
     * The one object id linked from {@code html}, or null when there is none or
     * more than one (ambiguous).
     */
    public static String sole(String html) {
        if (html == null || html.isEmpty()) {
            return null;
        }
        Matcher m = OBJECT_ID.matcher(html);
        if (!m.find()) {
            return null;
        }
        String id = m.group(1);
        return m.find() ? null : id;
    }

    /**
     * True when the text looks like it names a game object (XMage wrapped
     * something in a font tag) yet no id came out of it — i.e. an upgrade
     * changed {@code GameLog}'s attribute and the pinned pattern has drifted.
     */
    public static boolean canaryMissed(String html) {
        return html != null && html.contains(CANARY) && !OBJECT_ID.matcher(html).find();
    }

    /** Log the drift once per occurrence, naming the text that missed. */
    public static void warnDrift(String what, String html) {
        log.warn("{}: text carries an object name but no pinned object_id link "
                + "(1.4.60 GameLog drift?): {}", what, Html.strip(html));
    }

    private ObjectLink() {
    }
}
