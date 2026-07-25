package night.bridge.golden;

import mage.interfaces.callback.ClientCallbackMethod;
import mage.view.CardView;
import mage.view.CardsView;
import mage.view.GameClientMessage;
import mage.view.GameView;
import mage.view.PlayerView;
import mage.view.StackAbilityView;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assumptions.assumeFalse;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * M7 spike (plan §7.1): how reliably can the bridge name the object whose cost a
 * {@code GAME_PLAY_MANA} ask is paying? Replays every {@link
 * night.bridge.xmage.CallbackTap} capture under {@code bridge/logs/tap/} offline
 * — no server — and tallies three candidate derivations per ask:
 *
 * <ul>
 *   <li><b>(a) stack top</b> — the newest stack object, plus whether it is still
 *       unpaid ({@code CardView.paid}: {@code GameView} sets it from
 *       {@code getManaCostsToPay().isPaid()} / {@code GameView.checkPaid}).</li>
 *   <li><b>(c) the ask's own source link</b> — {@code ManaUtil.addSpecialManaPayAbilities}
 *       appends {@code baseObject.getLogName()} to the prompt text, and
 *       {@code GameLog.getColoredObjectIdName} writes the source's <em>full
 *       UUID</em> into an {@code object_id='…'} attribute.</li>
 * </ul>
 *
 * <p>Tagged {@code live} to stay out of the fast unit tier (it reads hundreds of
 * MB) even though it needs no server: run it with
 * {@code mvn test -Dsurefire.excludedGroups= -Dtest=PayManaAnchorReplayTest}.
 * Skips cleanly when no captures are present.
 */
@Tag("live")
class PayManaAnchorReplayTest {

    private static final Path TAP = Path.of("logs", "tap");
    private static final Pattern OBJECT_ID = Pattern.compile("object_id='([0-9a-f-]{36})'");

    @Test
    void tallyAnchorDerivationsAtEveryPayManaAsk() throws Exception {
        assumeTrue(Files.isDirectory(TAP), "no tap captures at " + TAP.toAbsolutePath());
        List<Path> captures;
        try (var s = Files.list(TAP)) {
            captures = s.filter(p -> p.toString().endsWith(".ser"))
                    .filter(p -> size(p) > 0)
                    .sorted()
                    .toList();
        }
        assumeFalse(captures.isEmpty(), "no .ser captures under " + TAP.toAbsolutePath());

        Tally all = new Tally();
        for (Path ser : captures) {
            Tally t = new Tally();
            Map<String, String> everSeen = new java.util.HashMap<>();
            GoldenFixtures.readTap(ser, cb -> {
                if (cb.getMethod() != ClientCallbackMethod.GAME_PLAY_MANA) {
                    if (cb.getMethod() == ClientCallbackMethod.GAME_UPDATE
                            || cb.getMethod() == ClientCallbackMethod.GAME_INIT) {
                        cb.decompressData();
                        if (cb.getData() instanceof GameView v) {
                            remember(everSeen, v);
                        }
                    }
                    return;
                }
                cb.decompressData();
                GameClientMessage msg = (GameClientMessage) cb.getData();
                GameView view = msg.getGameView();
                t.asks++;

                // ---- (c) the source link inside the ask's own message ----------------
                String raw = msg.getMessage() == null ? "" : msg.getMessage();
                Matcher m = OBJECT_ID.matcher(raw);
                String linked = m.find() ? m.group(1) : null;
                if (m.find()) {
                    t.multipleLinks++;      // more than one object_id in one ask
                }
                if (linked == null) {
                    t.noLink++;
                    t.noLinkSamples.add(trim(raw));
                    return;
                }
                t.linked++;

                // ---- (a) stack top ---------------------------------------------------
                CardsView stack = view == null ? null : view.getStack();
                Map.Entry<UUID, CardView> top = null;
                if (stack != null && !stack.isEmpty()) {
                    top = stack.entrySet().iterator().next();   // LinkedHashMap; GameView fills top → bottom
                } else {
                    t.emptyStack++;
                }
                if (top != null) {
                    t.stackSizes.merge(stack.size(), 1, Integer::sum);
                    if (top.getValue().isPaid()) {
                        t.topPaid++;
                    }
                    boolean ability = top.getValue() instanceof StackAbilityView;
                    if (linked.equals(top.getKey().toString())) {
                        t.linkIsStackTopId++;
                    } else if (ability && ((StackAbilityView) top.getValue()).getSourceCard() != null
                            && linked.equals(((StackAbilityView) top.getValue()).getSourceCard().getId().toString())) {
                        t.linkIsStackTopSource++;
                    } else {
                        t.linkElsewhere++;
                        if (t.elsewhereSamples.size() < 6) {
                            t.elsewhereSamples.add(top.getValue().getName()
                                    + (ability ? "(ability)" : "(spell)") + " vs " + trim(raw));
                        }
                    }
                }

                // ---- where does the linked id live in the seat's own view? ------------
                t.zones.merge(zoneOf(view, linked), 1, Integer::sum);
                t.everZones.merge("ever:" + everSeen.getOrDefault(linked, "never"), 1, Integer::sum);
            });
            System.out.printf("%-42s asks=%4d linked=%4d noLink=%3d | linkIsTopId=%4d "
                            + "linkIsTopSource=%4d elsewhere=%3d topPaid=%3d%n",
                    ser.getFileName(), t.asks, t.linked, t.noLink,
                    t.linkIsStackTopId, t.linkIsStackTopSource, t.linkElsewhere, t.topPaid);
            t.elsewhereSamples.forEach(x -> System.out.println("    link != stack top: " + x));
            all.add(t);
        }
        System.out.println("== payMana anchor spike ==");
        System.out.printf("asks=%d  linked=%d  noLink=%d  multipleLinks=%d  emptyStack=%d  topPaid=%d%n",
                all.asks, all.linked, all.noLink, all.multipleLinks, all.emptyStack, all.topPaid);
        System.out.printf("link == stack-top id: %d   link == stack-top source card: %d   elsewhere: %d%n",
                all.linkIsStackTopId, all.linkIsStackTopSource, all.linkElsewhere);
        System.out.println("stack sizes: " + all.stackSizes);
        System.out.println("linked id found in view zone: " + all.zones);
        System.out.println("linked id ever seen as a card actor: " + all.everZones);
        all.noLinkSamples.stream().limit(10).forEach(s -> System.out.println("  no link: " + s));
    }

    /** Record every id this seat has ever seen as a card/permanent actor, and where. */
    private static void remember(Map<String, String> seen, GameView view) {
        if (view.getMyHand() != null) {
            view.getMyHand().keySet().forEach(id -> seen.put(id.toString(), "hand"));
        }
        for (PlayerView p : view.getPlayers()) {
            p.getBattlefield().keySet().forEach(id -> seen.put(id.toString(), "battlefield"));
            if (p.getGraveyard() != null) {
                p.getGraveyard().keySet().forEach(id -> seen.put(id.toString(), "graveyard"));
            }
            if (p.getCommandObjectList() != null) {
                p.getCommandObjectList().forEach(c -> seen.put(c.getId().toString(), "command"));
            }
        }
    }

    /** Which zone of this seat's own view the id sits in ("absent" when nowhere). */
    private static String zoneOf(GameView view, String id) {
        if (view == null) {
            return "no-view";
        }
        UUID uuid = UUID.fromString(id);
        if (view.getStack() != null && view.getStack().containsKey(uuid)) {
            return "stack-id";
        }
        if (view.getStack() != null) {
            for (CardView cv : view.getStack().values()) {
                if (cv instanceof StackAbilityView sav && sav.getSourceCard() != null
                        && sav.getSourceCard().getId().equals(uuid)) {
                    return "stack-ability-source";
                }
            }
        }
        for (PlayerView p : view.getPlayers()) {
            if (p.getBattlefield().containsKey(uuid)) {
                return "battlefield";
            }
            if (p.getGraveyard() != null && p.getGraveyard().containsKey(uuid)) {
                return "graveyard";
            }
            if (p.getCommandObjectList() != null
                    && p.getCommandObjectList().stream().anyMatch(c -> uuid.equals(c.getId()))) {
                return "command";
            }
        }
        if (view.getMyHand() != null && view.getMyHand().containsKey(uuid)) {
            return "hand";
        }
        return "absent";
    }

    private static String trim(String s) {
        String t = s == null ? "" : s.replaceAll("<[^>]*>", "");
        return t.length() > 70 ? t.substring(0, 70) : t;
    }

    private static long size(Path p) {
        try {
            return Files.size(p);
        } catch (Exception e) {
            return 0;
        }
    }

    private static final class Tally {
        int asks;
        int linked;
        int noLink;
        int multipleLinks;
        int emptyStack;
        int topPaid;
        int linkIsStackTopId;
        int linkIsStackTopSource;
        int linkElsewhere;
        final Map<Integer, Integer> stackSizes = new TreeMap<>();
        final Map<String, Integer> zones = new TreeMap<>();
        final Map<String, Integer> everZones = new TreeMap<>();
        final Set<String> noLinkSamples = new HashSet<>();
        final List<String> elsewhereSamples = new ArrayList<>();

        void add(Tally t) {
            asks += t.asks;
            linked += t.linked;
            noLink += t.noLink;
            multipleLinks += t.multipleLinks;
            emptyStack += t.emptyStack;
            topPaid += t.topPaid;
            linkIsStackTopId += t.linkIsStackTopId;
            linkIsStackTopSource += t.linkIsStackTopSource;
            linkElsewhere += t.linkElsewhere;
            t.stackSizes.forEach((k, v) -> stackSizes.merge(k, v, Integer::sum));
            t.zones.forEach((k, v) -> zones.merge(k, v, Integer::sum));
            t.everZones.forEach((k, v) -> everZones.merge(k, v, Integer::sum));
            noLinkSamples.addAll(t.noLinkSamples);
        }
    }
}
