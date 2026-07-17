package night.bridge.proto.state;

/**
 * Protocol §6 {@code Step}. Wire strings are the constant names — note the
 * protocol's PRE_MAIN/POST_MAIN differ from XMage's PhaseStep names
 * (PRECOMBAT_MAIN/POSTCOMBAT_MAIN); ViewTranslator maps between them.
 */
public enum Step {
    UNTAP, UPKEEP, DRAW, PRE_MAIN, BEGIN_COMBAT, DECLARE_ATTACKERS,
    DECLARE_BLOCKERS, FIRST_COMBAT_DAMAGE, COMBAT_DAMAGE, END_COMBAT,
    POST_MAIN, END_TURN, CLEANUP
}
