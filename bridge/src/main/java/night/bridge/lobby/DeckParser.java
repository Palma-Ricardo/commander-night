package night.bridge.lobby;

import mage.cards.decks.DeckCardInfo;
import mage.cards.decks.DeckCardLists;
import night.bridge.proto.LobbyDeck;
import night.bridge.proto.LobbyState;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * .dck parsing (protocol §5, design §9): "N [SET:NUM] Name" lines, "SB:"
 * prefix marks the sideboard — where Commander decks keep the commander.
 * No card database involved: set+number is all XMage needs. Validation is
 * pre-flight friendliness (main+SB = 100, 1–2 commanders); XMage remains
 * the authority at joinTable.
 *
 * <p>The plain-list format rides the cards-index (design §9) and is not in
 * M2; LobbyService rejects it with a clear message.
 */
public final class DeckParser {

    private static final Pattern LINE =
            Pattern.compile("^(SB:\\s*)?(\\d+)\\s+\\[([^:\\]]+):([^\\]]+)]\\s+(.+?)\\s*$");
    private static final Pattern HEADER = Pattern.compile("^(NAME:|AUTHOR:|LAYOUT).*");

    public record Parsed(DeckCardLists deck, LobbyState.DeckInfo info) {

        public boolean valid() {
            return info.valid();
        }
    }

    public static Parsed parseDck(String content) {
        DeckCardLists deck = new DeckCardLists();
        List<String> problems = new ArrayList<>();
        Set<String> commanders = new LinkedHashSet<>();
        int lineNo = 0;
        for (String raw : content.split("\\r?\\n")) {
            lineNo++;
            String line = raw.strip();
            if (line.isEmpty() || HEADER.matcher(line).matches()) {
                continue;
            }
            Matcher m = LINE.matcher(line);
            if (!m.matches()) {
                problems.add("line " + lineNo + ": cannot parse: " + abbreviate(line));
                continue;
            }
            boolean sideboard = m.group(1) != null;
            int amount = Integer.parseInt(m.group(2));
            String setCode = m.group(3);
            String cardNumber = m.group(4);
            String cardName = m.group(5);
            for (int i = 0; i < amount; i++) {
                DeckCardInfo info = new DeckCardInfo(cardName, cardNumber, setCode);
                (sideboard ? deck.getSideboard() : deck.getCards()).add(info);
            }
            if (sideboard) {
                commanders.add(cardName);
            }
        }
        int main = deck.getCards().size();
        int side = deck.getSideboard().size();
        if (main + side != 100) {
            problems.add("Commander decks are exactly 100 cards; this one has "
                    + main + " main + " + side + " sideboard = " + (main + side));
        }
        if (side < 1 || side > 2) {
            problems.add("the commander belongs in the sideboard (SB: lines): expected 1–2 cards there, found " + side);
        }
        // Empty → absent is DeckInfo's own job now (protocol §5), so these ride as lists.
        return new Parsed(deck, new LobbyState.DeckInfo(
                problems.isEmpty(),
                List.copyOf(commanders),
                main + side,
                LobbyDeck.FORMAT_DCK,
                problems,
                List.of()));
    }

    private static String abbreviate(String line) {
        return line.length() <= 60 ? line : line.substring(0, 57) + "...";
    }

    private DeckParser() {
    }
}
