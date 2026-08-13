package night.bridge.ai;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Per-seat mutable scratch for a {@link Brain}, owned by the seat's
 * {@code AiSeatDriver} and touched only on that seat's single decision thread —
 * so it needs no synchronization. It replaces the old stringly-typed
 * {@code Map<String,Integer>} memo with typed accessors for the <em>loop-breaker</em>
 * state a brain needs to keep making forward progress when XMage re-asks a prompt
 * it can't yet satisfy (a spell it can't pay for, a source that can't contribute
 * to the remaining cost).
 *
 * <p>This is also the extension point for stronger play: future plan-following
 * state (this turn's plan, the identified threat) becomes a field here, with no
 * change to the {@link Brain} signature.
 */
public final class BrainContext {

    private final Map<String, Integer> confirmSeen = new HashMap<>();
    private final Map<String, Integer> payAttempts = new HashMap<>();

    private int landLevel = -1;
    private final Set<String> triedThisLevel = new HashSet<>();

    private int combatDeclared;
    private int combatTries;

    private String intendedBlockAttacker;

    /** How many times this exact confirm message has been seen, counting now. */
    public int confirmsSeen(String message) {
        return confirmSeen.merge(message, 1, Integer::sum);
    }

    /** Whether {@code id} has already been attempted at this land-count level. */
    public boolean alreadyTried(int landLevel, String id) {
        rollLandLevel(landLevel);
        return triedThisLevel.contains(id);
    }

    /** Record that {@code id} was attempted at this land-count level. */
    public void markTried(int landLevel, String id) {
        rollLandLevel(landLevel);
        triedThisLevel.add(id);
    }

    // A cast that aborted for want of mana at N lands should get another shot
    // once N grows — so the tried-set is scoped to the current land level and
    // cleared the moment it changes (also on a fresh game). Bounded by design.
    private void rollLandLevel(int landLevel) {
        if (landLevel != this.landLevel) {
            this.landLevel = landLevel;
            triedThisLevel.clear();
        }
    }

    /**
     * Note the size of the current combat {@code declared} set. A shrink means a
     * fresh combat began, so the per-combat declaration budget resets.
     */
    public void noteDeclared(int declaredCount) {
        if (declaredCount < combatDeclared) {
            combatTries = 0;
        }
        combatDeclared = declaredCount;
    }

    /** Declarations attempted in the current combat (budget guard). */
    public int combatTries() {
        return combatTries;
    }

    /** Count one more declaration attempt in the current combat. */
    public void bumpCombatTries() {
        combatTries++;
    }

    /** How many times this exact remaining-cost message has been paid against. */
    public int payAttempt(String message) {
        return payAttempts.merge(message, 1, Integer::sum);
    }

    /**
     * Remember which attacker the just-declared blocker is meant to block. XMage
     * splits a block into two asks — pick the blocker, then (only when it could
     * block more than one attacker) pick which attacker — so the pairing chosen at
     * the first ask has to survive to the second.
     */
    public void intendBlock(String attackerId) {
        this.intendedBlockAttacker = attackerId;
    }

    /** The attacker intended for the last-declared blocker; clears on read. */
    public String takeIntendedBlock() {
        String attackerId = intendedBlockAttacker;
        intendedBlockAttacker = null;
        return attackerId;
    }
}
