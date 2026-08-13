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
 * Heuristic bridge-AI brain — the first intelligence pass over
 * {@link FirstLegalMoveBrain}. It upgrades exactly the priority path:
 * <ul>
 *   <li><b>ranked play</b> — at a normal priority it ranks the legal plays by
 *       impact (lands first, then the biggest castable creature / highest-impact
 *       spell) instead of taking the first legal one;</li>
 *   <li><b>attack math</b> — declaring attackers, it swings only with creatures
 *       that aren't walking into a bad block (a blocker that both survives the hit
 *       and kills the attacker), and always swings unblockable evasion.</li>
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

    private final FirstLegalMoveBrain baseline = new FirstLegalMoveBrain();

    @Override
    public Answer decide(GameState state, GamePrompt prompt, BrainContext ctx) {
        if (prompt.kind() == GamePrompt.Kind.PRIORITY) {
            return priority(state, prompt, ctx);
        }
        return baseline.decide(state, prompt, ctx);
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

    /**
     * Attack declaration, one toggle per round trip: declare the next candidate
     * worth attacking with; when none remain, confirm done. Blocks are declined
     * (v1). A per-combat budget (reset when a fresh combat starts) bounds the loop
     * if a declaration reverts.
     */
    private static Answer declareCombat(GameState state, Combat combat, BrainContext ctx) {
        List<String> candidates = combat.candidates() == null ? List.of() : combat.candidates();
        List<String> declared = combat.declared() == null ? List.of() : combat.declared();
        ctx.noteDeclared(declared.size());

        if (Combat.ATTACKERS.equals(combat.role()) && ctx.combatTries() <= candidates.size() + 3) {
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
        return new Answer.Confirm(true);     // done declaring (or blocking — decline)
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
