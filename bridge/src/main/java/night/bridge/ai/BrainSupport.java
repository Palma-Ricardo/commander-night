package night.bridge.ai;

import night.bridge.proto.state.Card;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.Permanent;
import night.bridge.proto.state.Player;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Shared read helpers over the trimmed (protocol §6) {@link GameState} for the
 * brains. Pure functions, no state — every value comes from the immutable
 * snapshot the pump handed us.
 */
final class BrainSupport {

    private BrainSupport() {
    }

    /**
     * Parse a power/toughness string to an int. XMage sends display values, so
     * {@code "*"}, {@code "1+*"}, {@code "X"}, and null all read as 0 (unknown).
     */
    static int pt(String value) {
        if (value == null) {
            return 0;
        }
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** The seat's own player, or null if not yet resolvable. */
    static Player me(GameState state) {
        if (state == null || state.me() == null || state.players() == null) {
            return null;
        }
        String meId = state.me().playerId();
        for (Player p : state.players()) {
            if (p.id().equals(meId)) {
                return p;
            }
        }
        return null;
    }

    /** The player with this id, or null if the id isn't a player (e.g. a permanent). */
    static Player playerById(GameState state, String id) {
        if (state == null || state.players() == null || id == null) {
            return null;
        }
        for (Player p : state.players()) {
            if (id.equals(p.id())) {
                return p;
            }
        }
        return null;
    }

    /** Every player other than the seat's own. */
    static List<Player> opponents(GameState state) {
        List<Player> others = new ArrayList<>();
        if (state == null || state.me() == null || state.players() == null) {
            return others;
        }
        String meId = state.me().playerId();
        for (Player p : state.players()) {
            if (!p.id().equals(meId)) {
                others.add(p);
            }
        }
        return others;
    }

    /** My battlefield land count — the "mana grew, retry casts" level. */
    static int myLandCount(GameState state) {
        return landCount(me(state));
    }

    /** Battlefield land count for a player. */
    static int landCount(Player p) {
        int lands = 0;
        if (p != null && p.battlefield() != null) {
            for (Permanent perm : p.battlefield()) {
                if (isType(perm.types(), "LAND")) {
                    lands++;
                }
            }
        }
        return lands;
    }

    /** Untapped creatures a player controls — the set that could block. */
    static List<Permanent> untappedCreatures(Player p) {
        List<Permanent> out = new ArrayList<>();
        if (p != null && p.battlefield() != null) {
            for (Permanent perm : p.battlefield()) {
                if (isType(perm.types(), "CREATURE") && !perm.tapped()) {
                    out.add(perm);
                }
            }
        }
        return out;
    }

    /** A permanent the seat controls with this id, or null. */
    static Permanent myPermanent(GameState state, String objectId) {
        Player me = me(state);
        if (me == null || me.battlefield() == null) {
            return null;
        }
        for (Permanent perm : me.battlefield()) {
            if (objectId.equals(perm.id())) {
                return perm;
            }
        }
        return null;
    }

    /**
     * Any permanent on any player's battlefield with this id, or null. Used to
     * resolve an attacker (an opponent's creature) by the id combat hands us.
     */
    static Permanent findPermanent(GameState state, String objectId) {
        if (state == null || state.players() == null) {
            return null;
        }
        for (Player p : state.players()) {
            if (p.battlefield() == null) {
                continue;
            }
            for (Permanent perm : p.battlefield()) {
                if (objectId.equals(perm.id())) {
                    return perm;
                }
            }
        }
        return null;
    }

    /** The hand card with this id, or null. */
    static Card handCard(GameState state, String objectId) {
        if (state == null || state.me() == null || state.me().hand() == null) {
            return null;
        }
        for (Card card : state.me().hand()) {
            if (objectId.equals(card.id())) {
                return card;
            }
        }
        return null;
    }

    /** Whether the hand object with this id is a creature. */
    static boolean isCreatureInHand(GameState state, String objectId) {
        Card card = handCard(state, objectId);
        return card != null && isType(card.types(), "CREATURE");
    }

    /** Whether a type line contains a given card type (e.g. {@code "LAND"}). */
    static boolean isType(List<String> types, String type) {
        return types != null && types.contains(type);
    }

    /**
     * Whether any rules-text line mentions {@code word} (case-insensitive). The
     * only way to read keywords — there are no keyword fields on Card/Permanent,
     * so this is a deliberately fuzzy scan (good enough for a heuristic).
     */
    static boolean hasWord(List<String> text, String word) {
        if (text == null) {
            return false;
        }
        String needle = word.toLowerCase(Locale.ROOT);
        for (String line : text) {
            if (line != null && line.toLowerCase(Locale.ROOT).contains(needle)) {
                return true;
            }
        }
        return false;
    }
}
