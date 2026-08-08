package night.bridge.golden;

import mage.constants.Constants;
import mage.game.combat.CombatGroup;
import mage.view.CombatGroupView;
import mage.view.GameClientMessage;
import mage.view.GameView;

import java.io.Serializable;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Ground-truth probe for the "declared attacker doesn't move until the next
 * update" bug. For every callback that carries a GameView, prints the current
 * step + the view's combat groups, and specially flags GAME_SELECT asks that
 * carry POSSIBLE_ATTACKERS / POSSIBLE_BLOCKERS (a combat declaration ask). The
 * question: at the moment the "Select attackers" ask re-fires, does
 * getCombat() already list the just-declared attacker (with a defender), or is
 * it still empty until the step advances?
 *
 * mvn -q -Plive test-compile org.codehaus.mojo:exec-maven-plugin:java \
 *   -Dexec.classpathScope=test \
 *   -Dexec.mainClass=night.bridge.golden.CombatTapProbe \
 *   -Dexec.args="logs/tap/&lt;capture&gt;.ser"
 */
public final class CombatTapProbe {

    public static void main(String[] args) throws Exception {
        Path tap = Path.of(args[0]);
        int[] ordinal = {0};
        String[] lastCombat = {"<none>"};

        GoldenFixtures.readTap(tap, cb -> {
            int n = ordinal[0]++;
            cb.decompressData();
            Object data = cb.getData();
            GameView view = switch (data) {
                case GameView v -> v;
                case GameClientMessage m -> m.getGameView();
                default -> null;
            };

            boolean combatAsk = false;
            String askKind = null;
            if (cb.getMethod().name().equals("GAME_SELECT") && data instanceof GameClientMessage msg
                    && msg.getOptions() != null) {
                Serializable atk = msg.getOptions().get(Constants.Option.POSSIBLE_ATTACKERS);
                Serializable blk = msg.getOptions().get(Constants.Option.POSSIBLE_BLOCKERS);
                if (atk != null) { combatAsk = true; askKind = "ATTACKERS possible=" + sizeOf(atk); }
                else if (blk != null) { combatAsk = true; askKind = "BLOCKERS possible=" + sizeOf(blk); }
            }

            if (view == null) return;
            String step = view.getStep() == null ? "?" : view.getStep().name();
            String combat = describeCombat(view);

            if (combatAsk) {
                System.out.printf("#%d GAME_SELECT [%s] step=%s%n    combat: %s%n",
                        n, askKind, step, combat);
            } else if (!combat.equals(lastCombat[0])) {
                // Only print state updates when the combat picture actually changed,
                // so the interleaving of combat mutations vs asks is visible.
                System.out.printf("#%d %s step=%s%n    combat: %s%n",
                        n, cb.getMethod(), step, combat);
            }
            lastCombat[0] = combat;
        });
    }

    private static String describeCombat(GameView view) {
        List<CombatGroupView> groups = view.getCombat();
        if (groups == null || groups.isEmpty()) return "<empty>";
        StringBuilder sb = new StringBuilder();
        for (CombatGroupView g : groups) {
            sb.append("{atk=").append(ids(g.getAttackers()))
              .append(" def=").append(shortId(g.getDefenderId()))
              .append(" blk=").append(ids(g.getBlockers()))
              .append(" blocked=").append(g.isBlocked()).append("} ");
        }
        return sb.toString().trim();
    }

    private static String ids(Map<UUID, ?> m) {
        if (m == null || m.isEmpty()) return "[]";
        StringBuilder sb = new StringBuilder("[");
        for (UUID id : m.keySet()) sb.append(shortId(id)).append(",");
        sb.setLength(sb.length() - 1);
        return sb.append("]").toString();
    }

    private static int sizeOf(Serializable s) {
        return s instanceof List<?> l ? l.size() : -1;
    }

    private static String shortId(UUID id) {
        return id == null ? "-" : id.toString().substring(0, 8);
    }

    private CombatTapProbe() {
    }
}
