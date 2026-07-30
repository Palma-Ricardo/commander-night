package night.bridge.golden;

import mage.interfaces.callback.ClientCallback;
import mage.view.CardView;
import mage.view.GameClientMessage;
import mage.view.GameView;

import java.nio.file.Path;
import java.util.UUID;

/**
 * Tap autopsy — the debugging tool of first resort over a callback capture
 * (design §12), companion to {@link FixtureSelectMain}. Prints every dialog
 * ask with its payload shape (message, cardsViews, targets, options, choice),
 * cross-checks GAME_TARGET target ids against the asked player's own hand and
 * against the hand of the last state-update view (the staleness probe that
 * diagnosed Issues.txt #1), and flags views carrying revealed/lookedAt.
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

        GoldenFixtures.readTap(tap, cb -> {
            int n = ordinal[0]++;
            cb.decompressData();
            Object data = cb.getData();
            switch (cb.getMethod()) {
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
                    if (view != null) {
                        lastUpdateHand.clear();
                        lastUpdateHand.addAll(view.getMyHand().keySet());
                    }
                    if (view != null && (!view.getRevealed().isEmpty() || !view.getLookedAt().isEmpty())) {
                        revealedSeen[0]++;
                        if (revealedSeen[0] <= 5) {
                            StringBuilder sb = new StringBuilder();
                            view.getRevealed().forEach(r -> sb.append(" revealed[").append(r.getName())
                                    .append("]=").append(r.getCards().size()));
                            view.getLookedAt().forEach(l -> sb.append(" lookedAt[").append(l.getName())
                                    .append("]=").append(l.getCards().size()));
                            System.out.printf("#%d %s HAS-REVEALED:%s%n", n, cb.getMethod(), sb);
                        }
                    }
                }
                default -> {
                }
            }
        });
        System.out.printf("%ntotal callbacks: %d, updates carrying revealed/lookedAt: %d%n",
                ordinal[0], revealedSeen[0]);
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
