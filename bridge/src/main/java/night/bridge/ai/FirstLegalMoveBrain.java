package night.bridge.ai;

import night.bridge.proto.Answer;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.GamePrompt.Combat;
import night.bridge.proto.GamePrompt.PlayableAction;
import night.bridge.proto.state.Card;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.Permanent;
import night.bridge.proto.state.Player;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * v1 bridge-AI brain: a rule-based first-legal-move player, ported from the
 * live-test auto-player ({@code LiveHarness.autoAnswer}) onto the protocol
 * records. It finishes games; it does not play well. Stronger heuristics slot
 * in behind {@link Brain} without touching the seat/driver machinery.
 *
 * <p>Strategy: keep every hand; at priority play a land, else cast a creature,
 * else cast anything castable (each object tried once <em>per land-count
 * level</em>, so a cast that aborted for want of mana gets another shot once
 * more lands are down); attack with <em>all</em> eligible creatures each combat;
 * pay mana by rotating through the offered sources then cancelling; answer
 * everything else with the first option / the minimum. Stateless — all
 * per-seat memory lives in the {@code memo} map the driver owns.
 */
public final class FirstLegalMoveBrain implements Brain {

    @Override
    public Answer decide(GameState state, GamePrompt prompt, Map<String, Integer> memo) {
        String message = prompt.message() == null ? "" : prompt.message();
        return switch (prompt.kind()) {
            case CONFIRM -> confirm(message, memo);
            case PRIORITY -> priority(state, prompt, memo);
            case CHOOSE_TARGETS -> chooseTargets(prompt);
            case PAY_MANA -> payMana(prompt, message, memo);
            case CHOOSE_ABILITY -> new Answer.Pick(prompt.options().getFirst().id());
            case CHOOSE_OPTION -> new Answer.Option(prompt.options().getFirst().key());
            case CHOOSE_PILE -> new Answer.Pile(0);
            case CHOOSE_AMOUNT -> new Answer.Amount(prompt.min() == null ? 0 : prompt.min());
            case DISTRIBUTE -> distribute(prompt);
            case PLAYER_REQUEST -> new Answer.Option(prompt.options().getFirst().key());
        };
    }

    private static Answer confirm(String message, Map<String, Integer> memo) {
        int seen = memo.merge("confirm|" + message, 1, Integer::sum);
        boolean yes;
        if (message.contains("Mulligan")) {
            yes = false;                              // keep every hand
        } else if (message.contains("Pass anyway") || message.contains("mana pool")) {
            yes = true;                               // don't wedge on floating mana
        } else {
            yes = seen > 5;                           // escape an unforeseen repeating ask
        }
        return new Answer.Confirm(yes);
    }

    private static Answer priority(GameState state, GamePrompt prompt, Map<String, Integer> memo) {
        Combat combat = prompt.combat();
        if (combat != null) {
            return declareCombat(combat, memo);
        }
        // Lands first (free mana growth), then creature casts (the path to
        // combat), then anything else castable — each object tried once per
        // land-count level (a cast that aborted at N lands retries once N grows).
        String landLevel = "|L" + myLandCount(state);
        String land = null;
        String creature = null;
        String other = null;
        Map<String, List<PlayableAction>> playable =
                prompt.playable() == null ? Map.of() : prompt.playable();
        for (Map.Entry<String, List<PlayableAction>> e : playable.entrySet()) {
            boolean play = false;
            boolean cast = false;
            for (PlayableAction a : e.getValue()) {
                play |= PlayableAction.PLAY.equals(a.kind());
                cast |= PlayableAction.CAST.equals(a.kind());
            }
            if (!play && !cast) {
                continue;
            }
            String id = e.getKey();
            if (memo.getOrDefault("tried|" + id + landLevel, 0) > 0) {
                continue;
            }
            if (play && land == null) {
                land = id;
            } else if (cast && creature == null && isCreatureInHand(state, id)) {
                creature = id;
            } else if (cast && other == null) {
                other = id;
            }
        }
        String act = land != null ? land : creature != null ? creature : other;
        if (act != null) {
            memo.merge("tried|" + act + landLevel, 1, Integer::sum);
            return new Answer.Pick(act);
        }
        return new Answer.Confirm(false);            // pass priority
    }

    /**
     * One toggle per round trip (XMage re-fires the ask after each): declare
     * every eligible attacker in turn, then confirm done. Blocks are declined in
     * v1 (done = confirm of either value). A per-combat budget bounds the loop in
     * case an attack cost reverts a toggle; the budget resets when a fresh combat
     * starts (its {@code declared} set drops back below what we last saw).
     */
    private static Answer declareCombat(Combat combat, Map<String, Integer> memo) {
        List<String> candidates = combat.candidates() == null ? List.of() : combat.candidates();
        List<String> declared = combat.declared() == null ? List.of() : combat.declared();
        boolean attacking = Combat.ATTACKERS.equals(combat.role());

        int prevDeclared = memo.getOrDefault("combatDeclared", 0);
        if (declared.size() < prevDeclared) {
            memo.put("combatTries", 0);              // a new combat began
        }
        memo.put("combatDeclared", declared.size());

        if (attacking) {
            int tries = memo.getOrDefault("combatTries", 0);
            if (tries <= candidates.size() + 3) {
                for (String cand : candidates) {
                    if (!declared.contains(cand)) {
                        memo.put("combatTries", tries + 1);
                        return new Answer.Pick(cand);
                    }
                }
            }
        }
        return new Answer.Confirm(true);             // done declaring
    }

    private static Answer chooseTargets(GamePrompt prompt) {
        boolean required = Boolean.TRUE.equals(prompt.required());
        List<String> candidates = prompt.candidates() == null ? List.of() : prompt.candidates();
        int chosen = prompt.progress() == null ? 0 : prompt.progress().chosen();
        int max = prompt.max() == null ? 1 : prompt.max();
        if (required && !candidates.isEmpty()) {
            // Whole-set submit — the bridge replays it one UUID at a time (§8).
            int n = Math.min(max - chosen, candidates.size());
            List<String> picks = new ArrayList<>();
            for (int i = 0; i < Math.max(n, 1); i++) {
                picks.add(candidates.get(i));
            }
            return new Answer.Picks(picks);
        }
        if (required) {
            return new Answer.Confirm(true);         // done — nothing to pick
        }
        return new Answer.Cancel();
    }

    private static Answer payMana(GamePrompt prompt, String message, Map<String, Integer> memo) {
        // One source click per round trip (§8's payMana shape). Sources may include
        // objects that can't contribute to the remaining cost (XMage re-asks
        // identically), so rotate through them and cancel once each has had a try;
        // a shrunk remaining cost changes the message, resetting the counter.
        List<String> sources = prompt.sources();
        int attempt = memo.merge("pay|" + message, 1, Integer::sum);
        if (sources != null && !sources.isEmpty() && attempt <= sources.size()) {
            return new Answer.Pick(sources.get((attempt - 1) % sources.size()));
        }
        return new Answer.Cancel();
    }

    private static Answer distribute(GamePrompt prompt) {
        List<Answer.Distribution.Share> shares = new ArrayList<>();
        List<GamePrompt.Among> among = prompt.among() == null ? List.of() : prompt.among();
        for (GamePrompt.Among row : among) {
            long amount = row.suggested() != null ? row.suggested()
                    : row.min() != null ? row.min() : 0;
            shares.add(new Answer.Distribution.Share(row.id(), amount));
        }
        return new Answer.Distribution(shares);
    }

    /** My battlefield land count — the "mana grew, retry casts" level. */
    private static int myLandCount(GameState state) {
        if (state == null || state.me() == null || state.players() == null) {
            return 0;
        }
        String me = state.me().playerId();
        for (Player p : state.players()) {
            if (!p.id().equals(me)) {
                continue;
            }
            int lands = 0;
            if (p.battlefield() != null) {
                for (Permanent perm : p.battlefield()) {
                    if (perm.types() != null && perm.types().contains("LAND")) {
                        lands++;
                    }
                }
            }
            return lands;
        }
        return 0;
    }

    /** Whether the object in my hand is a creature (prefer casting those). */
    private static boolean isCreatureInHand(GameState state, String objectId) {
        if (state == null || state.me() == null || state.me().hand() == null) {
            return false;
        }
        for (Card card : state.me().hand()) {
            if (objectId.equals(card.id()) && card.types() != null
                    && card.types().contains("CREATURE")) {
                return true;
            }
        }
        return false;
    }
}
