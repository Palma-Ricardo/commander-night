package night.bridge.translate;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Commander damage / tax scrape (design §7, protocol §16.3). XMage exposes
 * commander state only as HTML info lines that {@code CommanderInfoWatcher}
 * injects into the commander's rules text — there is no structured field
 * anywhere in the view graph. The two shapes, pinned to 1.4.60 source
 * ({@code CommanderInfoWatcher.addCardInfoToCommander}):
 *
 * <pre>
 * &lt;b&gt;Commander&lt;/b&gt;[ N time(s) played from the command zone.]
 * &lt;b&gt;Commander&lt;/b&gt; did N combat damage to player &lt;font color='#20B2AA'&gt;Name&lt;/font&gt;.
 * </pre>
 *
 * The marker line exists from game init ({@code GameCommanderImpl.initCommander}
 * calls the watcher directly), so every commander view carries it in every
 * snapshot; the cast-count suffix appears after the first command-zone cast and
 * damage lines after the first combat damage. The lines stick to the card's
 * game state, so they surface wherever the commander currently is — command
 * zone, battlefield, even hand or graveyard.
 *
 * <p>{@link #scrape} runs on the RAW rules lines, before {@link Html#strip},
 * and returns the structured data plus the rules with the info lines removed
 * (they are presentation noise once the data is structured). A line that
 * matches neither pattern is left untouched — an upgrade that changes the text
 * degrades to the fields going absent (and the golden fixtures catching the
 * drift), never to failed translation.
 */
public final class CommanderDamage {

    private static final org.slf4j.Logger log =
            org.slf4j.LoggerFactory.getLogger(CommanderDamage.class);

    private static final Pattern MARKER = Pattern.compile(
            "<b>Commander</b>(?: (\\d+) times? played from the command zone\\.)?");
    private static final Pattern DAMAGE = Pattern.compile(
            "<b>Commander</b> did (\\d+) combat damage to player (.*)\\.");

    /** Substrings that mark a line as watcher output even when the pinned patterns miss. */
    private static final String CANARY_TAX = "played from the command zone";
    private static final String CANARY_DAMAGE = "combat damage to player";

    /**
     * One object's scrape. {@code castCount} is null when the marker line is
     * absent (not a commander, or an upgrade changed the text); the bare
     * marker parses as 0. {@code damageByPlayerName} keys are plain-text
     * player names (font tag stripped), insertion-ordered as encountered.
     */
    public record Scrape(Integer castCount,
                         Map<String, Integer> damageByPlayerName,
                         List<String> remainingRules) {

        public boolean isCommander() {
            return castCount != null;
        }
    }

    public static Scrape scrape(List<String> rawRules) {
        if (rawRules == null || rawRules.isEmpty()) {
            return new Scrape(null, Map.of(), rawRules == null ? List.of() : rawRules);
        }
        Integer castCount = null;
        Map<String, Integer> damage = new LinkedHashMap<>();
        List<String> remaining = new java.util.ArrayList<>(rawRules.size());
        for (String line : rawRules) {
            if (line == null) {
                continue;
            }
            Matcher m = MARKER.matcher(line);
            if (m.matches()) {
                castCount = m.group(1) == null ? 0 : Integer.parseInt(m.group(1));
                continue;
            }
            m = DAMAGE.matcher(line);
            if (m.matches()) {
                String name = Html.strip(m.group(2));
                if (!name.isEmpty()) {
                    damage.merge(name, Integer.parseInt(m.group(1)), Integer::max);
                    continue;
                }
            }
            if (line.contains(CANARY_TAX) || line.contains(CANARY_DAMAGE)) {
                // Watcher output the pinned patterns no longer match — an XMage
                // upgrade changed the text. Degrade to absent fields, but say so.
                log.warn("commander info line did not match pinned 1.4.60 patterns: {}", line);
            }
            remaining.add(line);
        }
        return new Scrape(castCount, damage, remaining);
    }

    private CommanderDamage() {
    }
}
