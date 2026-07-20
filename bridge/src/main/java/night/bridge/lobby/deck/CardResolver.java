package night.bridge.lobby.deck;

import mage.cards.decks.CardNameUtil;
import mage.cards.repository.CardInfo;

import java.util.List;

/**
 * Card name (plus optional printing) → a real XMage printing (deck-import spec §4).
 * The sole consumer of the card database.
 *
 * <p><b>Soft fallback.</b> Moxfield emits Scryfall set codes and XMage maintains
 * its own, so a strict lookup rejects legal decks over cosmetics — the sample
 * decks alone contain {@code (PLST) C15-60}, {@code (PLST) EMA-26} and
 * {@code (PVOW) 17p}. A missed set or number therefore downgrades to a warning
 * and a different printing of the same card; only a missed <em>name</em> is fatal.
 */
public final class CardResolver {

    /** Exactly one of {@code card} and {@code problem} is non-null. */
    public record Resolved(DeckLine line, CardInfo card, String warning, String problem) {
    }

    /**
     * Reproduces {@code TxtDeckImporter}'s normalisation so our lookups match what
     * XMage's own importer would find.
     */
    public static String normalize(String rawName) {
        String name = CardNameUtil.normalizeCardName(rawName);
        if (name.contains("//") && !name.contains(" // ")) {
            name = name.replace("//", " // ");
        }
        return name.replaceFirst("(?<=[^/])\\s*/\\s*(?=[^/])", " // ");
    }

    public static Resolved resolve(DeckLine line) {
        String name = normalize(line.name());

        if (line.setCode() == null) {
            CardInfo preferred = CardDb.cards().findPreferredCoreExpansionCard(name);
            return preferred == null ? miss(line, name) : new Resolved(line, preferred, null, null);
        }

        List<CardInfo> printings = CardDb.cards().findCards(name);

        // 1 — exact set + number
        CardInfo exact = printings.stream()
                .filter(c -> c.getSetCode().equalsIgnoreCase(line.setCode()))
                .filter(c -> c.getCardNumber().equalsIgnoreCase(line.number()))
                .findFirst().orElse(null);
        if (exact != null) {
            return new Resolved(line, exact, null, null);
        }

        // 2 — right set, any number
        CardInfo inSet = printings.stream()
                .filter(c -> c.getSetCode().equalsIgnoreCase(line.setCode()))
                .findFirst().orElse(null);
        if (inSet != null) {
            return new Resolved(line, inSet,
                    line.name() + " — no " + line.setCode() + ":" + line.number()
                            + " printing, used " + inSet.getSetCode() + ":" + inSet.getCardNumber(),
                    null);
        }

        // 3 — right card, any printing
        CardInfo preferred = CardDb.cards().findPreferredCoreExpansionCard(name);
        if (preferred != null) {
            return new Resolved(line, preferred,
                    line.name() + " — no " + line.setCode() + " printing, used "
                            + preferred.getSetCode() + ":" + preferred.getCardNumber(),
                    null);
        }
        return miss(line, name);
    }

    private static Resolved miss(DeckLine line, String normalized) {
        return new Resolved(line, null, null,
                "line " + line.lineNo() + ": no such card: " + line.name()
                        + (normalized.equals(line.name()) ? "" : " (read as '" + normalized + "')"));
    }

    private CardResolver() {
    }
}
