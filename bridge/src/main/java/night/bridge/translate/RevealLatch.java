package night.bridge.translate;

import night.bridge.proto.state.Card;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.NamedCards;
import night.bridge.proto.state.Player;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Stabilizes the transient {@code revealed}/{@code lookedAt} windows (protocol
 * §6). XMage 1.4.60 clears both maps after <em>every</em> view fire
 * ({@code GameImpl.firePriorityEvent}/{@code fireUpdatePlayersEvent} →
 * {@code clearLookedAt()/clearRevealed()}), and ask-path views are built after
 * that clear — so on the raw wire a persistent window (Experimental Frenzy's
 * "look at the top card any time") appears on roughly a third of plain updates
 * and on no ask views at all. Rendering the raw views flickers.
 *
 * <p>Latch policy, sized from a live capture (tap 5KM63T, 2026-07-29): while
 * the source effect lives, a window is re-confirmed within at most 2
 * view-carrying callbacks; wall-clock gaps are unbounded (a 67 s think produced
 * no views at all). So a latched window survives until {@link #MISS_LIMIT}
 * consecutive translated states arrive without it — never on elapsed time.
 *
 * <p>The seat's own single-card {@value #TOP_CARD_WINDOW} lookedAt window
 * (1.4.60 {@code LookAtTopCardOfLibraryAnyTimeEffect}'s pinned name) is folded
 * into that seat's {@code Player.topCard} — the client already renders topCard
 * face-up on the library pile, which is the right home for an all-game effect;
 * a real (public) {@code PlayerView.topCard} wins over the fold.
 *
 * <p>Per-seat mutable state: owned by the seat's pump, called only on its
 * executor (design §4).
 */
public final class RevealLatch {

    /** Consecutive stateless views before a latched window drops (4× the
     *  observed worst re-confirmation gap of 2). */
    static final int MISS_LIMIT = 8;

    /** Pinned 1.4.60 window name from LookAtTopCardOfLibraryAnyTimeEffect. */
    static final String TOP_CARD_WINDOW = "Top card of your library";

    private static final class Entry {
        final List<Card> cards;
        int misses;

        Entry(List<Card> cards) {
            this.cards = cards;
        }
    }

    private final Map<String, Entry> revealed = new LinkedHashMap<>();
    private final Map<String, Entry> lookedAt = new LinkedHashMap<>();

    /** Latch {@code state}'s windows and return the state with the stabilized
     *  lists (and the topCard fold) applied. */
    public GameState apply(GameState state) {
        merge(revealed, state.revealed());
        merge(lookedAt, state.lookedAt());

        List<Card> foldTop = null;
        List<NamedCards> looked = new ArrayList<>();
        for (Map.Entry<String, Entry> e : lookedAt.entrySet()) {
            if (TOP_CARD_WINDOW.equals(e.getKey()) && e.getValue().cards.size() == 1) {
                foldTop = e.getValue().cards;
            } else {
                looked.add(new NamedCards(e.getKey(), e.getValue().cards));
            }
        }
        List<NamedCards> reveals = revealed.isEmpty() ? null
                : revealed.entrySet().stream()
                        .map(e -> new NamedCards(e.getKey(), e.getValue().cards)).toList();

        List<Player> players = state.players();
        if (foldTop != null && state.me() != null) {
            Card top = foldTop.getFirst();
            players = new ArrayList<>(players);
            for (int i = 0; i < players.size(); i++) {
                Player p = players.get(i);
                if (p.id().equals(state.me().playerId()) && p.topCard() == null) {
                    players.set(i, new Player(p.id(), p.name(), p.human(), p.life(), p.counters(),
                            p.manaPool(), p.librarySize(), p.handSize(), p.battlefield(), p.graveyard(),
                            p.exile(), p.commandZone(), p.commanderDamage(), p.flags(), p.timer(), top));
                }
            }
        }

        return new GameState(state.gameId(), state.status(), state.rollbackTurnsAllowed(), state.turn(),
                players, state.stack(), state.combat(),
                reveals, looked.isEmpty() ? null : looked, state.me());
    }

    private static void merge(Map<String, Entry> latch, List<NamedCards> incoming) {
        java.util.Set<String> confirmed = new java.util.HashSet<>();
        if (incoming != null) {
            for (NamedCards w : incoming) {
                latch.put(w.name(), new Entry(w.cards()));   // content refresh, misses reset
                confirmed.add(w.name());
            }
        }
        latch.entrySet().removeIf(e ->
                !confirmed.contains(e.getKey()) && ++e.getValue().misses >= MISS_LIMIT);
    }
}
