package night.bridge.ai;

import night.bridge.proto.Answer;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.GamePrompt.Combat;
import night.bridge.proto.GamePrompt.PlayableAction;
import night.bridge.proto.state.Card;
import night.bridge.proto.state.CombatGroup;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.Permanent;
import night.bridge.proto.state.Player;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Heuristic bridge-AI brain — the first intelligence pass over
 * {@link FirstLegalMoveBrain}. It upgrades exactly the priority path:
 * <ul>
 *   <li><b>ranked play</b> — at a normal priority it ranks the legal plays by
 *       impact (lands first, then the biggest castable creature / highest-impact
 *       spell) instead of taking the first legal one;</li>
 *   <li><b>attack math</b> — declaring attackers, it swings only with creatures
 *       that aren't walking into a bad block (a blocker that both survives the hit
 *       and kills the attacker), and always swings unblockable evasion;</li>
 *   <li><b>block math</b> — declaring blockers, it blocks to kill-and-survive or
 *       to trade up, and chump-blocks only when the incoming damage is lethal.
 *       XMage splits a block into two asks (pick blocker, then pick which attacker
 *       — the latter only when the blocker could block more than one), so the
 *       chosen pairing is remembered on the {@link BrainContext} across the two.</li>
 * </ul>
 * Every other prompt kind (mulligan/confirm, targets, mana, amounts, options,
 * distribute, player-request) is delegated to {@link FirstLegalMoveBrain}, whose
 * behavior is already tested.
 *
 * <p>Pure static evaluation over the immutable snapshot plus a bounded combat
 * model over a handful of parsed ints — no game-state cloning and no lookahead,
 * so none of XMage's server-side simulation cost (the reason its AI was removed).
 */
public final class HeuristicBrain implements Brain {

    private static final Logger log = LoggerFactory.getLogger(HeuristicBrain.class);

    /** The exact message XMage fires for the block's second ask (HumanPlayer). */
    private static final String SELECT_ATTACKER_TO_BLOCK = "Select attacker to block";

    private final FirstLegalMoveBrain baseline = new FirstLegalMoveBrain();

    @Override
    public Answer decide(GameState state, GamePrompt prompt, BrainContext ctx) {
        return switch (prompt.kind()) {
            case PRIORITY -> priority(state, prompt, ctx);
            // The block's "which attacker?" follow-up is an ordinary target ask; we
            // recognize it by message and honor the pairing chosen at the blocker ask.
            case CHOOSE_TARGETS -> SELECT_ATTACKER_TO_BLOCK.equals(prompt.message())
                    ? chooseAttackerToBlock(state, prompt, ctx)
                    : baseline.decide(state, prompt, ctx);
            default -> baseline.decide(state, prompt, ctx);
        };
    }

    private static Answer priority(GameState state, GamePrompt prompt, BrainContext ctx) {
        Combat combat = prompt.combat();
        if (combat != null) {
            return declareCombat(state, combat, ctx);
        }
        return rankedPlay(state, prompt, ctx);
    }

    /**
     * Play a land if we have one (mana development is almost always right for
     * these bots), else cast the highest-impact castable spell. Objects already
     * tried at this land level are skipped so a spell we can't pay for doesn't
     * wedge the seat — we fall through to the next-best play, exactly as the
     * baseline does, just choosing the <em>best</em> legal play instead of the first.
     */
    private static Answer rankedPlay(GameState state, GamePrompt prompt, BrainContext ctx) {
        Map<String, List<PlayableAction>> playable =
                prompt.playable() == null ? Map.of() : prompt.playable();
        int lands = BrainSupport.myLandCount(state);

        String bestLand = null;
        String bestSpell = null;
        int bestSpellScore = Integer.MIN_VALUE;

        for (Map.Entry<String, List<PlayableAction>> e : playable.entrySet()) {
            String id = e.getKey();
            boolean play = false;
            boolean cast = false;
            for (PlayableAction a : e.getValue()) {
                play |= PlayableAction.PLAY.equals(a.kind());
                cast |= PlayableAction.CAST.equals(a.kind());
            }
            if (!play && !cast) {
                continue;                    // a mana/other ability, not a land drop or spell
            }
            if (ctx.alreadyTried(lands, id)) {
                continue;                    // tried at this mana level — don't wedge on it
            }
            if (play && bestLand == null) {
                bestLand = id;               // any land drop develops mana first
            } else if (cast) {
                int score = scoreSpell(state, id);
                if (score > bestSpellScore) {
                    bestSpellScore = score;
                    bestSpell = id;
                }
            }
        }
        String act = bestLand != null ? bestLand : bestSpell;
        if (act != null) {
            ctx.markTried(lands, act);
            return new Answer.Pick(act);
        }
        return new Answer.Confirm(false);    // nothing worth doing — pass priority
    }

    /**
     * Impact score for a castable hand object: creatures by board presence
     * (power + toughness) with a mana-value nudge and a baseline that keeps them
     * ahead of most utility spells; other spells by mana value; a small bonus for
     * card-advantage / removal text. Higher = cast sooner.
     */
    private static int scoreSpell(GameState state, String id) {
        Card card = BrainSupport.handCard(state, id);
        if (card == null) {
            return 0;
        }
        int score;
        if (BrainSupport.isType(card.types(), "CREATURE")) {
            score = 100 + BrainSupport.pt(card.power()) + BrainSupport.pt(card.toughness())
                    + card.manaValue();
        } else {
            score = card.manaValue();
        }
        if (BrainSupport.hasWord(card.text(), "destroy")
                || BrainSupport.hasWord(card.text(), "exile")
                || BrainSupport.hasWord(card.text(), "draw")) {
            score += 5;
        }
        return score;
    }

    private static Answer declareCombat(GameState state, Combat combat, BrainContext ctx) {
        List<String> declared = combat.declared() == null ? List.of() : combat.declared();
        ctx.noteDeclared(declared.size());
        return Combat.BLOCKERS.equals(combat.role())
                ? declareBlocks(state, combat, ctx)
                : declareAttacks(state, combat, ctx);
    }

    /**
     * Attack declaration, one toggle per round trip: declare the next candidate
     * worth attacking with; when none remain, confirm done. A per-combat budget
     * (reset when a fresh combat starts) bounds the loop if a declaration reverts.
     */
    private static Answer declareAttacks(GameState state, Combat combat, BrainContext ctx) {
        List<String> candidates = combat.candidates() == null ? List.of() : combat.candidates();
        List<String> declared = combat.declared() == null ? List.of() : combat.declared();

        if (ctx.combatTries() <= candidates.size() + 3) {
            List<Permanent> blockers = opponentUntappedCreatures(state);
            for (String cand : candidates) {
                if (declared.contains(cand)) {
                    continue;
                }
                if (worthAttacking(state, cand, blockers)) {
                    ctx.bumpCombatTries();
                    return new Answer.Pick(cand);
                }
            }
        }
        return new Answer.Confirm(true);     // done declaring
    }

    /**
     * Block declaration, one blocker per round trip. Pick the best (blocker,
     * attacker) pairing worth committing — remember which attacker it's for (the
     * follow-up ask needs it) — and toggle that blocker in; when no block is worth
     * it, confirm done and take the hits. Same per-combat budget guard as attacks.
     */
    private static Answer declareBlocks(GameState state, Combat combat, BrainContext ctx) {
        List<String> candidates = combat.candidates() == null ? List.of() : combat.candidates();
        List<String> declared = combat.declared() == null ? List.of() : combat.declared();

        if (ctx.combatTries() <= candidates.size() + 3) {
            Block block = bestBlock(state, candidates, declared);
            if (block != null) {
                ctx.bumpCombatTries();
                ctx.intendBlock(block.attackerId());
                log.debug("declaring block: {} blocks attacker {}", block.blockerId(), block.attackerId());
                return new Answer.Pick(block.blockerId());
            }
        }
        return new Answer.Confirm(true);     // nothing worth blocking — take the damage
    }

    /**
     * The "Select attacker to block" follow-up (fired only when the just-declared
     * blocker could block more than one attacker): assign it to the attacker we
     * planned, or — if that plan didn't survive — to the scariest attacker offered.
     * Optional, so an empty candidate set just cancels the pairing.
     */
    private static Answer chooseAttackerToBlock(GameState state, GamePrompt prompt, BrainContext ctx) {
        List<String> candidates = prompt.candidates() == null ? List.of() : prompt.candidates();
        String intended = ctx.takeIntendedBlock();
        if (candidates.isEmpty()) {
            return new Answer.Cancel();
        }
        if (intended != null && candidates.contains(intended)) {
            log.debug("block assign: honoring intended attacker {}", intended);
            return new Answer.Pick(intended);
        }
        String scariest = candidates.getFirst();
        int mostPower = Integer.MIN_VALUE;
        for (String id : candidates) {
            Permanent attacker = BrainSupport.findPermanent(state, id);
            int power = attacker == null ? 0 : BrainSupport.pt(attacker.power());
            if (power > mostPower) {
                mostPower = power;
                scariest = id;
            }
        }
        log.debug("block assign: intended gone, blocking scariest attacker {}", scariest);
        return new Answer.Pick(scariest);
    }

    /** A chosen defensive assignment: one of my creatures blocking one attacker. */
    private record Block(String blockerId, String attackerId) {
    }

    /**
     * The best single block to declare now, or null if none is worth it. Blocks
     * the biggest unblocked attacker first, choosing the cheapest creature that
     * kills it and survives; failing that a favorable/even trade; and a chump only
     * when the total unblocked damage is lethal.
     */
    private static Block bestBlock(GameState state, List<String> candidates, List<String> declared) {
        Player me = BrainSupport.me(state);
        if (me == null) {
            return null;
        }
        List<Permanent> attackers = unblockedAttackersOnMe(state, me.id());
        if (attackers.isEmpty()) {
            return null;
        }
        List<Permanent> blockers = new ArrayList<>();
        for (String id : candidates) {
            if (declared.contains(id)) {
                continue;                    // already assigned this combat
            }
            Permanent blocker = BrainSupport.myPermanent(state, id);
            if (blocker != null) {
                blockers.add(blocker);
            }
        }
        if (blockers.isEmpty()) {
            return null;
        }

        int incoming = 0;
        for (Permanent a : attackers) {
            incoming += Math.max(0, BrainSupport.pt(a.power()));
        }
        boolean lethal = incoming >= me.life();

        attackers.sort((x, y) -> BrainSupport.pt(y.power()) - BrainSupport.pt(x.power()));
        for (Permanent attacker : attackers) {
            Permanent blocker = chooseBlockerFor(attacker, blockers, lethal);
            if (blocker != null) {
                return new Block(blocker.id(), attacker.id());
            }
        }
        return null;
    }

    /**
     * Pick the creature to throw in front of {@code attacker}: prefer the smallest
     * that kills it and survives, else the smallest favorable/even trade, else —
     * only when we're facing lethal — the smallest chump. Null = leave it unblocked.
     */
    private static Permanent chooseBlockerFor(Permanent attacker, List<Permanent> blockers, boolean lethal) {
        int atkPower = BrainSupport.pt(attacker.power());
        int atkTough = BrainSupport.pt(attacker.toughness());
        boolean deathtouch = BrainSupport.hasWord(attacker.text(), "deathtouch");
        int atkValue = atkPower + atkTough;

        Permanent profit = null;             // kills and survives
        Permanent trade = null;              // kills but dies, and worth trading
        Permanent chump = null;              // dies for nothing — lethal only

        for (Permanent b : blockers) {
            if (!canBlock(b, attacker)) {
                continue;
            }
            int bPower = BrainSupport.pt(b.power());
            int bTough = BrainSupport.pt(b.toughness());
            boolean kills = bPower >= atkTough;
            boolean survives = bTough > atkPower && !deathtouch;
            if (kills && survives) {
                if (smaller(b, profit)) {
                    profit = b;
                }
            } else if (kills && (atkValue >= bPower + bTough || lethal)) {
                if (smaller(b, trade)) {
                    trade = b;
                }
            } else if (lethal) {
                if (smaller(b, chump)) {
                    chump = b;
                }
            }
        }
        if (profit != null) {
            return profit;
        }
        return trade != null ? trade : chump;
    }

    /** Smaller by power+toughness — keep the better creatures back. */
    private static boolean smaller(Permanent candidate, Permanent current) {
        if (current == null) {
            return true;
        }
        return BrainSupport.pt(candidate.power()) + BrainSupport.pt(candidate.toughness())
                < BrainSupport.pt(current.power()) + BrainSupport.pt(current.toughness());
    }

    /** A blocker can face a flyer only with flying or reach; ground blocks freely. */
    private static boolean canBlock(Permanent blocker, Permanent attacker) {
        if (BrainSupport.hasWord(attacker.text(), "flying")) {
            return BrainSupport.hasWord(blocker.text(), "flying")
                    || BrainSupport.hasWord(blocker.text(), "reach");
        }
        return true;
    }

    /** My attackers under fire: attackers in a combat group I defend, not yet blocked. */
    private static List<Permanent> unblockedAttackersOnMe(GameState state, String meId) {
        List<Permanent> out = new ArrayList<>();
        if (state.combat() == null) {
            return out;
        }
        for (CombatGroup group : state.combat()) {
            if (!meId.equals(group.defenderId())) {
                continue;
            }
            if (group.blockerIds() != null && !group.blockerIds().isEmpty()) {
                continue;                    // I've already put a blocker on this one
            }
            if (group.attackerIds() == null) {
                continue;
            }
            for (String attackerId : group.attackerIds()) {
                Permanent attacker = BrainSupport.findPermanent(state, attackerId);
                if (attacker != null) {
                    out.add(attacker);
                }
            }
        }
        return out;
    }

    /**
     * Attack with this creature unless it's clearly bad. Unblockable evasion
     * (flying with no flyer/reach across the table) always swings. Otherwise swing
     * unless some untapped blocker both survives the hit (its toughness beats our
     * power) and kills us (its power meets our toughness) — a block that eats the
     * attacker for free. Even and favorable trades still swing.
     */
    private static boolean worthAttacking(GameState state, String candidateId, List<Permanent> blockers) {
        Permanent attacker = BrainSupport.myPermanent(state, candidateId);
        if (attacker == null) {
            return true;                     // can't evaluate — default aggressive (games must end)
        }
        int power = BrainSupport.pt(attacker.power());
        int toughness = BrainSupport.pt(attacker.toughness());
        if (power <= 0) {
            return false;                    // 0-power (or "*") deals nothing — don't tap it in
        }
        if (isUnblockableEvasion(attacker, blockers)) {
            return true;
        }
        for (Permanent b : blockers) {
            boolean survives = BrainSupport.pt(b.toughness()) > power;
            boolean kills = BrainSupport.pt(b.power()) >= toughness;
            if (survives && kills) {
                return false;
            }
        }
        return true;
    }

    /** Flying with nothing across the table that can block a flyer. */
    private static boolean isUnblockableEvasion(Permanent attacker, List<Permanent> blockers) {
        if (!BrainSupport.hasWord(attacker.text(), "flying")) {
            return false;
        }
        for (Permanent b : blockers) {
            if (BrainSupport.hasWord(b.text(), "flying") || BrainSupport.hasWord(b.text(), "reach")) {
                return false;
            }
        }
        return true;
    }

    private static List<Permanent> opponentUntappedCreatures(GameState state) {
        List<Permanent> out = new ArrayList<>();
        for (Player opp : BrainSupport.opponents(state)) {
            out.addAll(BrainSupport.untappedCreatures(opp));
        }
        return out;
    }
}
