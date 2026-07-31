package night.bridge.golden;

import mage.interfaces.callback.ClientCallback;
import mage.view.CardView;
import mage.view.GameClientMessage;
import mage.view.GameView;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Tap autopsy — the debugging tool of first resort over a callback capture
 * (design §12), companion to {@link FixtureSelectMain}. Prints every dialog
 * ask with its payload shape (message, cardsViews, targets, options, choice),
 * cross-checks GAME_TARGET target ids against the asked player's own hand and
 * against the hand of the last state-update view (the staleness probe that
 * diagnosed Issues.txt #1), flags every view carrying revealed/lookedAt, prints
 * GAME_SELECT asks whose views carry windows, and tallies window presence per
 * callback method (the probe that sized RevealLatch: the server clears both
 * maps after every fire, so only ~1/3 of plain updates carry an active window
 * and ask views never do).
 *
 * <pre>
 * mvn -q test-compile org.codehaus.mojo:exec-maven-plugin:java \
 *   -Dexec.classpathScope=test \
 *   -Dexec.mainClass=night.bridge.golden.TapAutopsyMain \
 *   -Dexec.args="logs/tap/&lt;capture&gt;.ser"
 * </pre>
 */
public final class TapAutopsyMain {

    public static void main(String[] args) throws Exception {
        Path tap = Path.of(args[0]);
        int[] ordinal = {0};
        int[] revealedSeen = {0};
        // Hand of the most recent *state update* callback — what the client's
        // GameState would hold when a following ask is presented.
        java.util.Set<UUID> lastUpdateHand = new java.util.HashSet<>();
        // Per-method tally of views with/without revealed|lookedAt — the probe for
        // the server's fire-then-clear behavior (GameImpl clearLookedAt/clearRevealed
        // after every firePriorityEvent and fireUpdatePlayersEvent).
        java.util.Map<String, int[]> windowTally = new java.util.TreeMap<>();
        String[] seatOrder = {null};
        int[] lastActive = {-1};
        StringBuilder turnSeq = new StringBuilder();

        GoldenFixtures.readTap(tap, cb -> {
            int n = ordinal[0]++;
            cb.decompressData();
            Object data = cb.getData();
            GameView anyView = switch (data) {
                case GameView v -> v;
                case GameClientMessage m -> m.getGameView();
                default -> null;
            };
            if (anyView != null) {
                boolean has = !anyView.getRevealed().isEmpty() || !anyView.getLookedAt().isEmpty();
                windowTally.computeIfAbsent(cb.getMethod().name(), k -> new int[2])[has ? 0 : 1]++;
            }
            switch (cb.getMethod()) {
                case GAME_SELECT -> {
                    if (data instanceof GameClientMessage msg) {
                        StringBuilder w = new StringBuilder();
                        if (msg.getGameView() != null) {
                            msg.getGameView().getRevealed().forEach(r -> w.append(" revealed[").append(r.getName())
                                    .append("]=").append(r.getCards().size()));
                            msg.getGameView().getLookedAt().forEach(l -> w.append(" lookedAt[").append(l.getName())
                                    .append("]=").append(l.getCards().size()));
                        }
                        if (w.length() > 0) {
                            System.out.printf("#%d GAME_SELECT windows:%s · msg: %s%n", n, w, clip(msg.getMessage(), 100));
                        }
                    }
                }
                case GAME_TARGET, GAME_ASK, GAME_CHOOSE_ABILITY, GAME_CHOOSE_CHOICE,
                     GAME_GET_AMOUNT, GAME_GET_MULTI_AMOUNT, GAME_CHOOSE_PILE,
                     GAME_PLAY_MANA, GAME_PLAY_XMANA -> {
                    if (data instanceof GameClientMessage m2 && m2.getGameView() != null) {
                        // The bridge applies dialog-embedded views too (SeatPump
                        // updateState-before-dialog) — but only AFTER this ask is
                        // compared below, mirroring present-order. So: compare first,
                        // then absorb this ask's view.
                    }
                    if (data instanceof GameClientMessage msg) {
                        System.out.printf("#%d %s%n  msg: %s%n", n, cb.getMethod(), clip(msg.getMessage(), 160));
                        if (msg.getCardsView1() != null && !msg.getCardsView1().isEmpty()) {
                            System.out.printf("  cardsView1: %d cards, first=%s%n",
                                    msg.getCardsView1().size(), firstName(msg.getCardsView1().values().toArray(new CardView[0])));
                        }
                        if (msg.getCardsView2() != null && !msg.getCardsView2().isEmpty()) {
                            System.out.printf("  cardsView2: %d cards%n", msg.getCardsView2().size());
                        }
                        if (msg.getTargets() != null && !msg.getTargets().isEmpty()) {
                            System.out.printf("  targets: %d%n", msg.getTargets().size());
                        }
                        if (msg.getOptions() != null && !msg.getOptions().isEmpty()) {
                            System.out.printf("  options: %s%n", msg.getOptions().keySet());
                        }
                        // Discard-double diagnosis: do the target ids exist in the
                        // asked player's own hand view at ask time?
                        if (msg.getTargets() != null && !msg.getTargets().isEmpty()
                                && msg.getGameView() != null) {
                            var handIds = msg.getGameView().getMyHand().keySet();
                            long inHand = msg.getTargets().stream().filter(handIds::contains).count();
                            long inLast = msg.getTargets().stream().filter(lastUpdateHand::contains).count();
                            System.out.printf("  targets-in-myHand: %d/%d (hand size %d) · in-last-UPDATE-hand: %d/%d (last hand %d)%n",
                                    inHand, msg.getTargets().size(), handIds.size(),
                                    inLast, msg.getTargets().size(), lastUpdateHand.size());
                            if (inHand < msg.getTargets().size()) {
                                msg.getTargets().stream().limit(3).forEach(t ->
                                        System.out.printf("    target %s inHand=%b%n",
                                                shortId(t), handIds.contains(t)));
                                handIds.stream().limit(3).forEach(h ->
                                        System.out.printf("    hand   %s%n", shortId(h)));
                            }
                        }
                        // Target-coverage probe (Issues.txt, 2026-07-31: "Aura Shards
                        // never let me target my opponent's Blind Obedience"). The
                        // bridge forwards msg.getTargets() verbatim as protocol §8
                        // `candidates`, so the question "did the client hide a legal
                        // target, or did the server never offer it?" is answered here:
                        // every battlefield permanent in the ask's OWN view, split into
                        // offered and not-offered, with the controller named.
                        if ("GAME_TARGET".equals(cb.getMethod().name())
                                && msg.getTargets() != null && msg.getGameView() != null) {
                            targetCoverage(msg);
                        }
                        if (msg.getChoice() != null) {
                            System.out.printf("  choice: %s keyChoices=%s%n",
                                    clip(msg.getChoice().getMessage(), 80),
                                    msg.getChoice().isKeyChoice() ? msg.getChoice().getKeyChoices() : "-");
                        }
                        System.out.printf("  min/max: %d/%d flag=%b%n", msg.getMin(), msg.getMax(), msg.isFlag());
                    } else {
                        System.out.printf("#%d %s (data: %s)%n", n, cb.getMethod(),
                                data == null ? "null" : data.getClass().getSimpleName());
                    }
                }
                case GAME_UPDATE, GAME_UPDATE_AND_INFORM, GAME_INIT -> {
                    GameView view = switch (data) {
                        case GameView v -> v;
                        case GameClientMessage m -> m.getGameView();
                        default -> null;
                    };
                    // Seat-order probe: the players list is the seat order the client
                    // lays out clockwise from you, so it must be the order turns
                    // actually pass in. Prints the list once, then every change of
                    // active player as an index into it (Issues.txt #17).
                    if (view != null && view.getPlayers() != null && !view.getPlayers().isEmpty()) {
                        if (seatOrder[0] == null) {
                            StringBuilder sb = new StringBuilder();
                            for (var p : view.getPlayers()) sb.append(sb.isEmpty() ? "" : ", ").append(p.getName());
                            seatOrder[0] = sb.toString();
                            System.out.printf("players[] order: [%s]%n", seatOrder[0]);
                        }
                        var act = view.getActivePlayerId();
                        if (act != null) {
                            int idx = -1;
                            var ps = view.getPlayers();
                            for (int i = 0; i < ps.size(); i++) {
                                if (act.equals(ps.get(i).getPlayerId())) { idx = i; break; }
                            }
                            if (idx >= 0 && idx != lastActive[0]) {
                                lastActive[0] = idx;
                                turnSeq.append(turnSeq.isEmpty() ? "" : " → ").append(idx);
                            }
                        }
                    }
                    if (view != null) {
                        lastUpdateHand.clear();
                        lastUpdateHand.addAll(view.getMyHand().keySet());
                    }
                    if (view != null && (!view.getRevealed().isEmpty() || !view.getLookedAt().isEmpty())) {
                        revealedSeen[0]++;
                        StringBuilder sb = new StringBuilder();
                        view.getRevealed().forEach(r -> sb.append(" revealed[").append(r.getName())
                                .append("]=").append(r.getCards().size()));
                        view.getLookedAt().forEach(l -> sb.append(" lookedAt[").append(l.getName())
                                .append("]=").append(l.getCards().size()));
                        System.out.printf("#%d %s HAS-REVEALED:%s%n", n, cb.getMethod(), sb);
                    }
                }
                default -> {
                }
            }
        });
        System.out.printf("%ntotal callbacks: %d, updates carrying revealed/lookedAt: %d%n",
                ordinal[0], revealedSeen[0]);
        System.out.printf("active-player sequence (indices into players[]): %s%n", turnSeq);
        System.out.println("views carrying revealed/lookedAt, per method (with/without):");
        windowTally.forEach((m, t) -> System.out.printf("  %-24s %d/%d%n", m, t[0], t[0] + t[1]));
    }

    /**
     * Print what a GAME_TARGET ask offered against what was actually on the
     * table. Anything in the "not offered" list is a permanent XMage itself
     * ruled out (protection, a controller/zone restriction in the filter, or
     * simply the wrong type) — never something the bridge dropped, which
     * forwards this set verbatim.
     */
    private static void targetCoverage(GameClientMessage msg) {
        var view = msg.getGameView();
        var offered = msg.getTargets();
        List<String> yes = new ArrayList<>();
        List<String> no = new ArrayList<>();
        int board = 0;
        for (var pv : view.getPlayers()) {
            for (var e : pv.getBattlefield().entrySet()) {
                board++;
                String label = e.getValue().getName() + " (" + pv.getName() + ")";
                (offered.contains(e.getKey()) ? yes : no).add(label);
            }
        }
        long offBoard = offered.stream().filter(t -> view.getPlayers().stream()
                .noneMatch(pv -> pv.getBattlefield().containsKey(t))).count();
        System.out.printf("  board: %d permanents · offered %d of them (+%d off-board ids)%n",
                board, yes.size(), offBoard);
        System.out.printf("    offered:     %s%n", clip(String.join(", ", yes), 220));
        System.out.printf("    NOT offered: %s%n", clip(String.join(", ", no), 220));
    }

    private static String firstName(CardView[] cards) {
        if (cards.length == 0) {
            return "-";
        }
        CardView cv = cards[0];
        return cv.getName() + " (id " + shortId(cv.getId()) + ")";
    }

    private static String shortId(UUID id) {
        return id == null ? "-" : id.toString().substring(0, 8);
    }

    private static String clip(String s, int len) {
        if (s == null) {
            return "-";
        }
        String flat = s.replaceAll("\\s+", " ");
        return flat.length() <= len ? flat : flat.substring(0, len) + "…";
    }

    private TapAutopsyMain() {
    }
}
