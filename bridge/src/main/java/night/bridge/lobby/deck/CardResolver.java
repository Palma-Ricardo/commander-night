package night.bridge.lobby.deck;

import mage.cards.decks.CardNameUtil;
import mage.cards.repository.CardInfo;

import java.util.Comparator;
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
        public Resolved {
            if ((card == null) == (problem == null)) {
                throw new IllegalArgumentException(
                        "exactly one of card and problem must be non-null (card=" + card
                                + ", problem=" + problem + ")");
            }
        }
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

        // 1 — exact set + number. Deliberately case-insensitive on the collector
        // number (equalsIgnoreCase), unlike XMage's own analogous matcher
        // (CardRepository#findCardWithPreferredSetAndNumber), which uses case-sensitive
        // equals. No known real collector number pair differs only by case, so this is
        // left as-is rather than "fixed" to match XMage's stricter behaviour.
        CardInfo exact = printings.stream()
                .filter(c -> c.getSetCode().equalsIgnoreCase(line.setCode()))
                .filter(c -> c.getCardNumber().equalsIgnoreCase(line.number()))
                .findFirst().orElse(null);
        if (exact != null) {
            return new Resolved(line, exact, null, null);
        }

        // 2 — right set, any number. CardRepository#findCards has no ORDER BY (see
        // vendor/mage's CardRepository.java), so which printing comes back first for a
        // set with more than one (e.g. Commander Masters shipped both a normal and a
        // showcase/etched Sol Ring under set code CMM) is not contractually fixed.
        // Break the tie deterministically: lowest collector number numerically, then
        // lowest lexicographically for suffixed variants that share a numeric prefix
        // (e.g. "410" vs "410a"). This mirrors the numeric-then-string tiebreak
        // precedent in CardRepository.OldestNonPromoComparator, and in practice tends
        // to prefer a set's normal-border printing over later bonus/showcase reprints,
        // which are appended with higher numbers.
        CardInfo inSet = printings.stream()
                .filter(c -> c.getSetCode().equalsIgnoreCase(line.setCode()))
                .min(Comparator.comparingInt(CardInfo::getCardNumberAsInt)
                        .thenComparing(CardInfo::getCardNumber))
                .orElse(null);
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
                    line.name() + " — no " + line.setCode() + ":" + line.number()
                            + " printing, used " + preferred.getSetCode() + ":" + preferred.getCardNumber(),
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
