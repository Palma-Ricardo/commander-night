package night.bridge.proto;

import java.util.List;

/**
 * Full lobby snapshot on every change (protocol §5) — small enough that no
 * diffing is needed. {@code deck} is null until a seat has submitted one.
 */
public record LobbyState(
        String code,
        String hostUserId,
        List<Seat> seats) implements ServerMsg {

    public record Seat(String userId, String name, DeckInfo deck, boolean ready) {
    }

    /**
     * One seat's deck verdict (protocol §5). {@code format} is the syntax the bridge
     * actually parsed the text as ({@code dck}, {@code moxfield} or {@code mtgo}) —
     * null only when the text was rejected before a syntax could be established.
     *
     * <p>{@code commander} carries one element per detected commander: the Moxfield
     * export does not mark them, so the bridge infers them, and echoing the names
     * verbatim is how a wrong inference is caught before anyone readies (protocol §5).
     *
     * <p>The optional arrays are <em>empty means absent</em> on the wire. The
     * deck-import pipeline speaks in empty lists and the wire omits them, so this is
     * where the two conventions meet: empty is normalized to null here rather than at
     * every call site, making {@code null} and {@code List.of()} indistinguishable to
     * a client. {@code problems} being empty is exactly {@code valid}.
     */
    public record DeckInfo(
            boolean valid,
            List<String> commander,
            int cards,
            String format,
            List<String> problems,
            List<String> warnings) {

        public DeckInfo {
            commander = omitEmpty(commander);
            problems = omitEmpty(problems);
            warnings = omitEmpty(warnings);
        }

        private static List<String> omitEmpty(List<String> values) {
            return values == null || values.isEmpty() ? null : List.copyOf(values);
        }
    }
}
