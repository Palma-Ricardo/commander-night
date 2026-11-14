package night.bridge.lobby.deck;

import mage.cards.decks.CardNameUtil;
import mage.cards.repository.CardInfo;

import java.util.ArrayList;
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
     * XMage's own importer would find — including its split-card heuristic, which
     * rewrites any single {@code "/"} between two non-slash characters to
     * {@code " // "} (deck files write "Fire/Ice" for the "Fire // Ice" printing).
     */
    public static String normalize(String rawName) {
        return normalizeBase(rawName).replaceFirst("(?<=[^/])\\s*/\\s*(?=[^/])", " // ");
    }

    /**
     * Unicode + {@code "//"}-spacing normalisation, <em>without</em> the single-slash
     * split rewrite. This is the name as written, canonicalised — needed because a
     * few real card names carry a literal slash. In 1.4.60's db {@code
     * "Summon: Choco/Mog"} (FIN) is the only one, and XMage's own {@code
     * TxtDeckImporter} mangles it to the nonexistent {@code "Summon: Choco // Mog"}
     * and fails to import it. {@link #resolve} falls back to this form so we don't
     * inherit that bug.
     *
     * <p>Its {@code "//"} respacing still destroys a name whose literal slash is a
     * <em>spaceless double</em> one — see {@link #normalizeVerbatim}.
     */
    static String normalizeBase(String rawName) {
        String name = CardNameUtil.normalizeCardName(rawName);
        if (name.contains("//") && !name.contains(" // ")) {
            name = name.replace("//", " // ");
        }
        return name;
    }

    /**
     * Unicode normalisation only — no slash rewriting at all. 1.4.63 added {@code
     * "SP//dr, Piloted by Peni"} (SPM), whose name carries a literal spaceless
     * {@code "//"}: both other forms respace it to {@code "SP // dr, …"}, which is
     * no card. The last name fallback in {@link #resolve}.
     */
    static String normalizeVerbatim(String rawName) {
        return CardNameUtil.normalizeCardName(rawName);
    }

    public static Resolved resolve(DeckLine line) {
        // Try the split-normalised name first: this is XMage's behaviour and covers
        // every split card written with a bare slash. Only when that misses entirely
        // (no such name in any printing) do we retry progressively less rewritten
        // forms, which rescue real card names with a literal slash: "Summon:
        // Choco/Mog" (single slash, survives normalizeBase) and "SP//dr, Piloted by
        // Peni" (spaceless double slash, survives only normalizeVerbatim).
        String splitName = normalize(line.name());
        Resolved bySplit = resolveNamed(line, splitName);
        if (bySplit.card() != null) {
            return bySplit;
        }
        List<String> tried = new ArrayList<>(List.of(splitName));
        for (String name : List.of(normalizeBase(line.name()), normalizeVerbatim(line.name()))) {
            if (tried.contains(name)) {
                continue;
            }
            tried.add(name);
            Resolved byName = resolveNamed(line, name);
            if (byName.card() != null) {
                return byName;
            }
        }
        // No card by that name in any form — but a name-independent set+number hit
        // rescues functional reprints XMage files under the original card's name.
        // WotC's Universes Beyond bonus sheets (FF's "Through the Ages" FCA, and the
        // Marvel set the user hit) reprint classics under new flavour names/art:
        // the deck says "Zidane Tribal", XMage stores FCA:43 as "Ragavan, Nimble
        // Pilferer". The printing is the same object, so the set code + collector
        // number the deck carries identify it exactly. Only fires on a true name
        // miss with an explicit printing, so it never masks a plain misspelling
        // (those carry no set/number — see aMisspellingIsAHardError).
        if (line.setCode() != null && line.number() != null) {
            CardInfo byPrint = CardDb.cards().findCard(line.setCode(), line.number());
            if (byPrint != null) {
                return new Resolved(line, byPrint,
                        line.name() + " — no card by that name; resolved "
                                + byPrint.getSetCode() + ":" + byPrint.getCardNumber()
                                + " as '" + byPrint.getName() + "' (functional reprint / alt name)",
                        null);
            }
        }
        return bySplit;
    }

    private static Resolved resolveNamed(DeckLine line, String name) {

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
