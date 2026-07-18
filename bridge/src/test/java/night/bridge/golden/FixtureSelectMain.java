package night.bridge.golden;

import mage.interfaces.callback.ClientCallback;
import mage.view.CardView;
import mage.view.CommandObjectView;
import mage.view.GameClientMessage;
import mage.view.GameView;
import mage.view.PlayerView;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.ObjectOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Curates golden fixtures out of a live game's callback tap (design §13).
 *
 * <pre>
 * mvn -q test-compile org.codehaus.mojo:exec-maven-plugin:java \
 *   -Dexec.classpathScope=test \
 *   -Dexec.mainClass=night.bridge.golden.FixtureSelectMain \
 *   -Dexec.args="logs/tap/&lt;capture&gt;.ser"
 * </pre>
 *
 * Selection (first match unless said otherwise): GAME_INIT; the GAME_UPDATE
 * with the fullest battlefields (best trim coverage); GAME_UPDATEs carrying
 * commander tax and commander damage info lines (the M5 scrape, pinned on
 * real payloads); one of each dialog callback method; the combat-declaration
 * GAME_SELECT. Fixture bytes are the PRE-decompression serialized callback —
 * exactly what the tap wrote — so the golden test replays the true wire
 * object. Existing fixture files are never overwritten (re-running against a
 * new capture only fills gaps; delete files to force reselection).
 */
public final class FixtureSelectMain {

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("usage: FixtureSelectMain <tap.ser> [outDir]");
            System.exit(2);
        }
        Path tap = Path.of(args[0]);
        Path out = args.length > 1 ? Path.of(args[1]) : GoldenFixtures.DIR;
        Files.createDirectories(out);

        Map<String, byte[]> picked = new LinkedHashMap<>();
        int[] ordinal = {0};
        int[] bestBattlefield = {-1};

        GoldenFixtures.readTap(tap, cb -> {
            int n = ordinal[0]++;
            byte[] wire = serialize(cb);    // fixture payload: pre-decompress bytes
            cb.decompressData();
            Object data = cb.getData();
            switch (cb.getMethod()) {
                case GAME_INIT -> {
                    if (data instanceof GameView) {
                        pick(picked, "game_init", wire, n);
                    }
                }
                case GAME_UPDATE -> {
                    if (!(data instanceof GameView view)) {
                        return;
                    }
                    int permanents = battlefieldSize(view);
                    if (permanents > bestBattlefield[0]) {
                        bestBattlefield[0] = permanents;
                        picked.put("game_update.big-board", wire);
                    }
                    // tax must sit on a COMMAND-ZONE commander: castCount only
                    // surfaces on CommandObjects, so a battlefield-only tax line
                    // pins nothing but the strip (which commander-damage covers)
                    if (commandZoneRulesContain(view, "played from the command zone")) {
                        pick(picked, "game_update.commander-tax", wire, n);
                    }
                    if (containsRulesLine(view, "combat damage to player")) {
                        pick(picked, "game_update.commander-damage", wire, n);
                    }
                }
                case GAME_SELECT -> {
                    pick(picked, "game_select", wire, n);
                    if (data instanceof GameClientMessage msg && msg.getOptions() != null
                            && (msg.getOptions().containsKey("possibleAttackers")
                                || msg.getOptions().containsKey("possibleBlockers"))) {
                        pick(picked, "game_select.combat", wire, n);
                    }
                }
                case GAME_ASK, GAME_TARGET, GAME_PLAY_MANA, GAME_CHOOSE_ABILITY,
                     GAME_CHOOSE_CHOICE, GAME_CHOOSE_PILE, GAME_GET_AMOUNT,
                     GAME_GET_MULTI_AMOUNT, GAME_PLAY_XMANA, USER_REQUEST_DIALOG ->
                        pick(picked, cb.getMethod().name().toLowerCase(java.util.Locale.ROOT), wire, n);
                default -> {
                }
            }
        });

        int written = 0;
        for (Map.Entry<String, byte[]> e : picked.entrySet()) {
            Path file = out.resolve(e.getKey() + ".ser");
            if (Files.exists(file)) {
                System.out.println("keep    " + file + " (exists)");
                continue;
            }
            Files.write(file, e.getValue());
            System.out.println("fixture " + file + " (" + e.getValue().length + " bytes)");
            written++;
        }
        System.out.printf("%d callbacks scanned, %d fixtures selected, %d written to %s%n",
                ordinal[0], picked.size(), written, out);
        System.out.println("next: mvn test -Dtest=GoldenFixtureTest -Dgolden.regen=true && review + commit");
    }

    private static void pick(Map<String, byte[]> picked, String name, byte[] wire, int ordinal) {
        if (picked.putIfAbsent(name, wire) == null) {
            System.out.println("select  " + name + " <- callback #" + ordinal);
        }
    }

    private static byte[] serialize(ClientCallback cb) {
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(64 * 1024);
            try (ObjectOutputStream oos = new ObjectOutputStream(bytes)) {
                oos.writeObject(cb);
            }
            return bytes.toByteArray();
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    private static int battlefieldSize(GameView view) {
        int total = 0;
        for (PlayerView p : view.getPlayers()) {
            total += p.getBattlefield().size();
        }
        return total;
    }

    private static boolean commandZoneRulesContain(GameView view, String needle) {
        for (PlayerView p : view.getPlayers()) {
            for (CommandObjectView co : p.getCommandObjectList()) {
                if (co instanceof CardView cv && rulesContain(cv, needle)) {
                    return true;
                }
            }
        }
        return false;
    }

    /** Looks for watcher output in command zones and battlefields — the scrape sites. */
    private static boolean containsRulesLine(GameView view, String needle) {
        for (PlayerView p : view.getPlayers()) {
            for (CommandObjectView co : p.getCommandObjectList()) {
                if (co instanceof CardView cv && rulesContain(cv, needle)) {
                    return true;
                }
            }
            for (CardView cv : p.getBattlefield().values()) {
                if (rulesContain(cv, needle)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean rulesContain(CardView cv, String needle) {
        if (cv.getRules() == null) {
            return false;
        }
        for (String line : cv.getRules()) {
            if (line != null && line.contains(needle)) {
                return true;
            }
        }
        return false;
    }

    private FixtureSelectMain() {
    }
}
