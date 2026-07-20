package night.bridge.lobby.deck;

import mage.cards.Card;
import mage.cards.decks.DeckCardInfo;
import mage.cards.decks.DeckCardLists;
import mage.cards.repository.CardInfo;
import mage.util.validation.ChooseABackgroundValidator;
import mage.util.validation.CommanderValidator;
import mage.util.validation.DoctorsCompanionValidator;
import mage.util.validation.PartnerValidator;
import mage.util.validation.PartnerVariantValidator;
import mage.util.validation.PartnerWithValidator;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Resolved lines → an XMage {@link DeckCardLists} plus diagnostics
 * (deck-import spec §4).
 *
 * <p><b>Partners.</b> Only .moxfield needs inference: it folds commanders into the
 * head of its single stanza, and card count cannot disambiguate (one commander
 * plus 99 and two plus 98 both total 100). XMage answers this itself — the five
 * {@link CommanderValidator}s cover every pairing mechanic (Partner, Partner with,
 * partner variants, Backgrounds, Doctor's companion), so new mechanics arrive with
 * the pinned jar rather than a patch to us. This is the same validator list and
 * calling convention as XMage's own {@code AbstractCommander.checkPartners}.
 */
public final class DeckAssembler {

    private static final List<CommanderValidator> VALIDATORS = List.of(
            PartnerValidator.instance,
            PartnerVariantValidator.instance,
            PartnerWithValidator.instance,
            ChooseABackgroundValidator.instance,
            DoctorsCompanionValidator.instance);

    public static DeckImport assemble(DeckFormat format, ParsedLines parsed) {
        List<String> problems = new ArrayList<>(parsed.problems());
        List<String> warnings = new ArrayList<>();
        for (ParsedLines.Discarded d : parsed.discarded()) {
            warnings.add("ignored " + d.cards() + " cards in section " + d.section());
        }

        List<CardResolver.Resolved> resolved = new ArrayList<>();
        for (DeckLine line : parsed.lines()) {
            CardResolver.Resolved r = CardResolver.resolve(line);
            if (r.problem() != null) {
                problems.add(r.problem());
                continue;
            }
            if (r.warning() != null) {
                warnings.add(r.warning());
            }
            resolved.add(r);
        }

        boolean partners = isPartnerPair(resolved);
        DeckCardLists deck = new DeckCardLists();
        Set<String> commanders = new LinkedHashSet<>();
        for (CardResolver.Resolved r : resolved) {
            boolean commander = switch (r.line().section()) {
                case COMMANDER -> true;
                case MAYBE_COMMANDER -> partners;
                case MAIN -> false;
            };
            CardInfo card = r.card();
            for (int i = 0; i < r.line().qty(); i++) {
                DeckCardInfo info = new DeckCardInfo(
                        card.getName(), card.getCardNumber(), card.getSetCode());
                (commander ? deck.getSideboard() : deck.getCards()).add(info);
            }
            if (commander) {
                commanders.add(card.getName());
            }
        }

        int main = deck.getCards().size();
        int side = deck.getSideboard().size();
        if (main + side != 100) {
            problems.add("Commander decks are exactly 100 cards; this one has "
                    + main + " deck + " + side + " commander = " + (main + side));
        }
        if (side < 1 || side > 2) {
            problems.add("expected 1–2 commanders, found " + side);
        }

        return new DeckImport(format, deck, List.copyOf(commanders), main + side,
                List.copyOf(problems), List.copyOf(warnings));
    }

    /**
     * True when the first two resolved lines are a legal commander pair. Only
     * consulted for {@link DeckLine.Section#MAYBE_COMMANDER}; .dck and .mtgo state
     * their commander count structurally.
     */
    private static boolean isPartnerPair(List<CardResolver.Resolved> resolved) {
        CardInfo first = sectionCard(resolved, DeckLine.Section.COMMANDER);
        CardInfo second = sectionCard(resolved, DeckLine.Section.MAYBE_COMMANDER);
        if (first == null || second == null) {
            return false;
        }
        Card a = first.createCard();
        Card b = second.createCard();
        return VALIDATORS.stream().anyMatch(v -> v.checkBothPartners(a, b));
    }

    private static CardInfo sectionCard(List<CardResolver.Resolved> resolved, DeckLine.Section s) {
        return resolved.stream()
                .filter(r -> r.line().section() == s)
                .map(CardResolver.Resolved::card)
                .findFirst().orElse(null);
    }

    private DeckAssembler() {
    }
}
