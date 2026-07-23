package night.bridge.translate;

import night.bridge.proto.LogEntry;
import night.bridge.proto.event.AttackEvent;
import night.bridge.proto.event.BlockEvent;
import night.bridge.proto.event.Cause;
import night.bridge.proto.event.CountersEvent;
import night.bridge.proto.event.DamageEvent;
import night.bridge.proto.event.GameEvent;
import night.bridge.proto.event.HiddenEvent;
import night.bridge.proto.event.LifeEvent;
import night.bridge.proto.event.MoveEvent;
import night.bridge.proto.event.RevealEvent;
import night.bridge.proto.event.ScryEvent;
import night.bridge.proto.event.SearchEvent;
import night.bridge.proto.event.ShuffleEvent;
import night.bridge.proto.event.StackLinkEvent;
import night.bridge.proto.event.StepEvent;
import night.bridge.proto.event.TapEvent;
import night.bridge.proto.event.TriggerEvent;
import night.bridge.proto.event.UntapEvent;
import night.bridge.proto.event.Verb;
import night.bridge.proto.event.Zone;
import night.bridge.proto.state.Card;
import night.bridge.proto.state.CombatGroup;
import night.bridge.proto.state.CommandObject;
import night.bridge.proto.state.Counter;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.NamedCards;
import night.bridge.proto.state.Permanent;
import night.bridge.proto.state.Player;
import night.bridge.proto.state.StackItem;
import night.bridge.proto.state.Step;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * M6 semantic-event derivation (design §4–§5, protocol §7.1). Joins the game
 * log — which arrives one callback <em>ahead</em> of the state it describes and
 * speaks in stable object ids (design §3) — against the state delta between two
 * consecutive trimmed {@link GameState}s, and emits the advisory
 * {@link GameEvent}s that explain how the board got from {@code prev} to
 * {@code next}.
 *
 * <p><b>State is authoritative, the log enriches.</b> The delta decides which
 * object moved and its {@code from}/{@code to} for every transition between the
 * <em>enumerated</em> zones (my hand, and everyone's battlefield / graveyard /
 * exile / command); the log supplies the verb and cause, and fills the one
 * missing endpoint when a card crosses the ephemeral stack, the library, or an
 * opponent's hidden hand — none of which are enumerated. A default-verb table
 * (§{@link #defaultVerb}) makes every enumerated transition emittable with no
 * log at all, so the M6 coverage assertion (design §12) holds even when the log
 * is silent. Everything here is advisory: a wrong or missing event costs an
 * animation, never correctness (protocol §7.1), so the deriver always prefers
 * to emit <em>something</em> over nothing.
 *
 * <p>Pure and stateless: the pump owns the previous trimmed state and the
 * buffered log; this class only reads them (design §4). The log phrasings are
 * pinned to XMage 1.4.60, exactly as {@link CommanderDamage} pins its scrape.
 */
public final class EventDeriver {

    private EventDeriver() {
    }

    // --- pinned 1.4.60 log phrasings (subject is always the first card ref) -------------
    private static final Pattern CAST =
            Pattern.compile("\\bcasts\\b.*\\bfrom (hand|command|graveyard|exile|library)\\b",
                    Pattern.CASE_INSENSITIVE);
    private static final Pattern ONTO_BATTLEFIELD =
            Pattern.compile("\\bfrom (stack|hand|library|graveyard|exile|command) onto the Battlefield\\b",
                    Pattern.CASE_INSENSITIVE);
    private static final Pattern INTO_GRAVEYARD =
            Pattern.compile("\\bfrom (stack|hand|library|graveyard|exile) into (?:their|his|her|the) graveyard\\b",
                    Pattern.CASE_INSENSITIVE);
    private static final Pattern DESTROYED_BY =
            Pattern.compile("\\bwas destroyed by\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern DIES_FROM =
            Pattern.compile("\\bis put into graveyard from (battlefield|exile|library|hand|stack|command)\\b"
                    + "(?:.*?\\(([^)]*)\\))?", Pattern.CASE_INSENSITIVE);
    private static final Pattern SACRIFICED =
            Pattern.compile("\\bsacrificed\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern COUNTERED_BY =
            Pattern.compile("\\bis countered by\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern MOVES_ZONE =
            Pattern.compile("\\bmoves\\b.*\\bfrom (\\w+) to (?:the )?(\\w+) zone\\b",
                    Pattern.CASE_INSENSITIVE);
    private static final Pattern RETURNS_HAND =
            Pattern.compile("\\b(?:returns|is returned).*\\bto\\b.*\\bhand\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern DRAWS =
            Pattern.compile("\\bdraws (\\w+) cards?\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern TUTOR_TO_HAND =
            Pattern.compile("\\bputs a card from library into (?:their|his|her) hand\\b",
                    Pattern.CASE_INSENSITIVE);
    // A mana tap: "… adds {G}" / "adds {C}{C}". The first ref is the source that
    // tapped, so its objectId marks a tap as forMana (best-effort — advisory).
    private static final Pattern ADDS_MANA =
            Pattern.compile("\\badds\\b[^\\n]*\\{[WUBRGCSXP0-9/]+\\}", Pattern.CASE_INSENSITIVE);
    // Life swings: "X loses 3 life" / "X gains 2 life". Enriches the LifeEvent
    // cause when a source ref rides the same line; the amount comes from state.
    private static final Pattern LOSES_LIFE =
            Pattern.compile("\\bloses \\d+ life\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern GAINS_LIFE =
            Pattern.compile("\\bgains \\d+ life\\b", Pattern.CASE_INSENSITIVE);
    // Library flourishes — no enumerated-zone delta, so purely log-derived and
    // best-effort. These match only a *discrete action* line, in the third
    // person/past ("… shuffles their library", "… scries 2"), never the imperative
    // wording XMage prints inside ability/reminder text ("scry 1", "search your
    // library … then shuffle") — that text describes what an ability does, not that
    // it happened now, and would false-fire on every Temple ETB or Ob Nixilis
    // trigger. Ability-description / activation lines are excluded outright
    // ({@link #isAbilityText}); confirmed against the 1.4.60 tap captures.
    private static final Pattern SHUFFLES =
            Pattern.compile("\\bshuffles\\b.*\\blibrary\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern SCRIES =
            Pattern.compile("\\bscr(?:ies|ied)\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern SEARCHES =
            Pattern.compile("\\bsearches\\b.*\\blibrary\\b", Pattern.CASE_INSENSITIVE);
    // The two markers XMage prefixes onto ability text (as opposed to an action):
    // "<player> - Ability triggers: …" and "<player> activates: …".
    private static final Pattern ABILITY_TEXT =
            Pattern.compile("\\bability triggers:|\\bactivates:", Pattern.CASE_INSENSITIVE);

    /**
     * Derive the events explaining the transition {@code prev → next}. Empty on
     * the first snapshot of a game (nothing to compare) or when nothing moved.
     */
    public static List<GameEvent> derive(GameState prev, GameState next, List<LogEntry> logs) {
        if (prev == null || next == null) {
            return List.of();
        }
        List<GameEvent> out = new ArrayList<>();

        StepEvent step = stepEvent(prev, next);
        if (step != null) {
            out.add(step);
        }

        Map<String, Loc> prevLoc = locMap(prev);
        Map<String, Loc> nextLoc = locMap(next);
        Set<String> tokenIds = new HashSet<>();
        collectTokens(next, tokenIds);

        List<LogHint> hints = new ArrayList<>();
        List<AnonHint> anon = new ArrayList<>();
        parseLogs(logs, hints, anon);
        Map<String, LogHint> hintById = new HashMap<>();
        for (LogHint h : hints) {
            hintById.put(h.subjectId(), h);   // one movement line per card per delta in practice
        }
        List<LogHint> castHints = new ArrayList<>();
        for (LogHint h : hints) {
            if (h.verb() == Verb.CAST) {
                castHints.add(h);
            }
        }

        List<MoveEvent> moves = new ArrayList<>();
        List<StackLinkEvent> links = new ArrayList<>();
        List<TriggerEvent> triggers = new ArrayList<>();
        Set<String> handled = new HashSet<>();
        Map<String, Boolean> castToStack = new HashMap<>();

        // Stack: bind each new stack item to the stable id behind it (§3). Abilities
        // carry their source card; spells pair, in order, to the cast lines (casting
        // is sequential, so this is 1:1 in practice), with a single-disappeared-card
        // fallback when the log said nothing.
        Set<String> prevStack = stackIds(prev);
        int castIdx = 0;
        for (StackItem si : next.stack()) {
            if (prevStack.contains(si.id())) {
                continue;
            }
            if (si.kind() == StackItem.Kind.ABILITY && si.card() != null) {
                links.add(new StackLinkEvent(si.id(), si.card().id()));
                // An ability from a source went on the stack: the client spawns an
                // ephemeral ghost of that source rather than moving the permanent
                // (design §9) — one permanent can stack several abilities at once.
                triggers.add(new TriggerEvent(si.card().id(), si.id()));
            } else {
                String stable = castIdx < castHints.size() ? castHints.get(castIdx++).subjectId()
                        : soleDisappeared(prevLoc, nextLoc);
                if (stable != null) {
                    links.add(new StackLinkEvent(si.id(), stable));
                    castToStack.put(stable, Boolean.TRUE);
                }
            }
        }

        // Casts: emitted from the log so a cast from a non-enumerated zone (library,
        // graveyard flashback) is caught too. State supplies the true `from` when the
        // card was on the enumerated board a moment ago.
        for (LogHint h : castHints) {
            String id = h.subjectId();
            if (nextLoc.containsKey(id)) {
                continue;   // still on the enumerated board — a normal move, handled below
            }
            Loc p = prevLoc.get(id);
            Zone from = p != null ? p.zone() : h.from() != null ? h.from() : Zone.HAND;
            moves.add(new MoveEvent(id, from, Zone.STACK, Verb.CAST, h.cause(), h.reason()));
            handled.add(id);
            castToStack.put(id, Boolean.TRUE);
        }

        // Every enumerated-zone transition, driven by the delta and enriched by the log.
        TreeSet<String> ids = new TreeSet<>();
        ids.addAll(prevLoc.keySet());
        ids.addAll(nextLoc.keySet());
        for (String id : ids) {
            if (handled.contains(id)) {
                continue;
            }
            Loc p = prevLoc.get(id);
            Loc n = nextLoc.get(id);
            LogHint h = hintById.get(id);
            if (p != null && n != null) {
                if (p.zone() != n.zone()) {
                    moves.add(new MoveEvent(id, p.zone(), n.zone(),
                            verbFor(h, p.zone(), n.zone()), cause(h), reason(h)));
                }
            } else if (p != null) {           // left to a non-enumerated zone
                Zone to = castToStack.containsKey(id) ? Zone.STACK
                        : h != null && h.to() != null ? h.to()
                        : defaultDisappearTo(p.zone());
                Verb verb = castToStack.containsKey(id) ? Verb.CAST : verbFor(h, p.zone(), to);
                moves.add(new MoveEvent(id, p.zone(), to, verb, cause(h), reason(h)));
            } else {                          // arrived from a non-enumerated zone
                boolean token = tokenIds.contains(id);
                Zone from = h != null && h.from() != null ? h.from()
                        : token ? n.zone()
                        : defaultAppearFrom(n.zone());
                Verb verb = token ? Verb.TOKEN : verbFor(h, from, n.zone());
                moves.add(new MoveEvent(id, from, n.zone(), verb, cause(h), reason(h)));
            }
        }

        moves.sort(Comparator.comparing(MoveEvent::objectId));
        out.addAll(moves);
        links.sort(Comparator.comparing(StackLinkEvent::stackId));
        out.addAll(links);

        // Hidden: an opponent's anonymous draws/tutors — no id exists on our side, so
        // the count-only delta becomes card backs. My own draws are visible ids already.
        String meId = next.me() == null ? null : next.me().playerId();
        List<HiddenEvent> hidden = new ArrayList<>();
        for (AnonHint a : anon) {
            if (a.playerId() == null || a.playerId().equals(meId)) {
                continue;
            }
            hidden.add(new HiddenEvent(a.playerId(), a.from(), a.to(), a.count(), a.verb()));
        }
        hidden.sort(Comparator.comparing(HiddenEvent::playerId));
        out.addAll(hidden);

        // ── T4 choreography (protocol §7.1) ─────────────────────────────────────
        // Derived from the same state delta + log the moves are, in a stable order
        // so the array is reproducible (the client plays events in order). Each is
        // advisory: a missing one costs an animation, never the board.
        deriveTapUntap(prev, next, logs, out);
        deriveCombat(prev, next, out);
        deriveDamage(prev, next, out);
        deriveLife(prev, next, logs, out);
        deriveCounters(prev, next, out);
        triggers.sort(Comparator.comparing(TriggerEvent::stackId,
                Comparator.nullsLast(Comparator.naturalOrder())));
        out.addAll(triggers);
        deriveReveal(prev, next, out);
        deriveLibraryOps(logs, out);

        return out;
    }

    // --- tap / untap (protocol §7.1) --------------------------------------------------

    /** A permanent whose {@code tapped} flag flipped between the two states. An
     *  enters-tapped permanent (absent in {@code prev}) is a move, not a tap, so it
     *  is skipped. {@code forMana} rides a best-effort "adds {…}" log scan. */
    private static void deriveTapUntap(GameState prev, GameState next, List<LogEntry> logs, List<GameEvent> out) {
        Map<String, Permanent> before = battlefield(prev);
        Set<String> mana = manaSourceIds(logs);
        List<TapEvent> taps = new ArrayList<>();
        List<UntapEvent> untaps = new ArrayList<>();
        for (Map.Entry<String, Permanent> e : battlefield(next).entrySet()) {
            Permanent was = before.get(e.getKey());
            if (was == null) {
                continue;
            }
            boolean pre = was.tapped();
            boolean now = e.getValue().tapped();
            if (!pre && now) {
                taps.add(new TapEvent(e.getKey(), mana.contains(e.getKey()) ? Boolean.TRUE : null));
            } else if (pre && !now) {
                untaps.add(new UntapEvent(e.getKey()));
            }
        }
        taps.sort(Comparator.comparing(TapEvent::objectId));
        untaps.sort(Comparator.comparing(UntapEvent::objectId));
        out.addAll(taps);
        out.addAll(untaps);
    }

    // --- attack / block (protocol §7.1) -----------------------------------------------

    /** Combat declarations from the {@code combat} groups that appear (attackers) or
     *  gain blockers between the two states, so declare-attackers and declare-blockers
     *  each emit exactly once and a later same-combat transition repeats neither. */
    private static void deriveCombat(GameState prev, GameState next, List<GameEvent> out) {
        List<CombatGroup> ng = next.combat();
        if (ng == null || ng.isEmpty()) {
            return;
        }
        Set<String> prevAttackers = new HashSet<>();
        Map<String, Set<String>> prevBlockers = new HashMap<>();
        for (CombatGroup g : prev.combat() == null ? List.<CombatGroup>of() : prev.combat()) {
            for (String a : safe(g.attackerIds())) {
                prevAttackers.add(a);
                prevBlockers.computeIfAbsent(a, k -> new HashSet<>()).addAll(safe(g.blockerIds()));
            }
        }
        List<AttackEvent> attacks = new ArrayList<>();
        List<BlockEvent> blocks = new ArrayList<>();
        for (CombatGroup g : ng) {
            List<String> atk = safe(g.attackerIds());
            if (atk.isEmpty()) {
                continue;
            }
            if (atk.stream().anyMatch(a -> !prevAttackers.contains(a))) {
                attacks.add(new AttackEvent(atk, g.defenderId()));
            }
            List<String> blk = safe(g.blockerIds());
            if (!blk.isEmpty()) {
                for (String a : atk) {
                    Set<String> seen = prevBlockers.getOrDefault(a, Set.of());
                    if (blk.stream().anyMatch(b -> !seen.contains(b))) {
                        blocks.add(new BlockEvent(a, blk));
                    }
                }
            }
        }
        attacks.sort(Comparator.comparing(AttackEvent::defenderId, Comparator.nullsLast(Comparator.naturalOrder())));
        blocks.sort(Comparator.comparing(BlockEvent::attackerId, Comparator.nullsLast(Comparator.naturalOrder())));
        out.addAll(attacks);
        out.addAll(blocks);
    }

    // --- damage (protocol §7.1) -------------------------------------------------------

    /** Marked damage that rose on a surviving permanent, plus a player's life loss in
     *  a combat-damage step (the running total also rides a {@link LifeEvent}; this is
     *  the impact — flash / number / shake). */
    private static void deriveDamage(GameState prev, GameState next, List<GameEvent> out) {
        boolean combat = isCombatDamageStep(next);
        List<DamageEvent> dmg = new ArrayList<>();
        Map<String, Permanent> before = battlefield(prev);
        for (Map.Entry<String, Permanent> e : battlefield(next).entrySet()) {
            Permanent was = before.get(e.getKey());
            int pre = was == null ? 0 : nz(was.damage());
            int now = nz(e.getValue().damage());
            if (now > pre) {
                dmg.add(new DamageEvent(e.getKey(), now - pre, combat));
            }
        }
        if (combat) {
            Map<String, Player> pl = players(prev);
            for (Player p : next.players()) {
                Player was = pl.get(p.id());
                if (was != null && p.life() < was.life()) {
                    dmg.add(new DamageEvent(p.id(), was.life() - p.life(), true));
                }
            }
        }
        dmg.sort(Comparator.comparing(DamageEvent::targetId));
        out.addAll(dmg);
    }

    // --- life (protocol §7.1) ---------------------------------------------------------

    private static void deriveLife(GameState prev, GameState next, List<LogEntry> logs, List<GameEvent> out) {
        Map<String, Cause> causes = lifeCauses(logs);
        Map<String, Player> before = players(prev);
        List<LifeEvent> life = new ArrayList<>();
        for (Player p : next.players()) {
            Player was = before.get(p.id());
            if (was != null && was.life() != p.life()) {
                life.add(new LifeEvent(p.id(), was.life(), p.life(), causes.get(p.id())));
            }
        }
        life.sort(Comparator.comparing(LifeEvent::playerId));
        out.addAll(life);
    }

    // --- counters (protocol §7.1) -----------------------------------------------------

    /** Per-name counter deltas on surviving permanents (a permanent that entered this
     *  step is skipped — its counters ride the entrance, not a pop). */
    private static void deriveCounters(GameState prev, GameState next, List<GameEvent> out) {
        Map<String, Permanent> before = battlefield(prev);
        List<CountersEvent> evs = new ArrayList<>();
        for (Map.Entry<String, Permanent> e : battlefield(next).entrySet()) {
            Permanent was = before.get(e.getKey());
            if (was == null) {
                continue;
            }
            Map<String, Integer> pre = counterMap(was.counters());
            Map<String, Integer> now = counterMap(e.getValue().counters());
            TreeSet<String> names = new TreeSet<>();
            names.addAll(pre.keySet());
            names.addAll(now.keySet());
            for (String name : names) {
                int a = pre.getOrDefault(name, 0);
                int b = now.getOrDefault(name, 0);
                if (a != b) {
                    evs.add(new CountersEvent(e.getKey(), name, a, b));
                }
            }
        }
        evs.sort(Comparator.comparing(CountersEvent::objectId).thenComparing(CountersEvent::name));
        out.addAll(evs);
    }

    // --- reveal (protocol §7.1) -------------------------------------------------------

    /** A shared reveal window that is new this step (matched by name + card ids). */
    private static void deriveReveal(GameState prev, GameState next, List<GameEvent> out) {
        List<NamedCards> nr = next.revealed();
        if (nr == null || nr.isEmpty()) {
            return;
        }
        Set<String> prevSigs = new HashSet<>();
        for (NamedCards w : prev.revealed() == null ? List.<NamedCards>of() : prev.revealed()) {
            prevSigs.add(revealSig(w));
        }
        for (NamedCards w : nr) {
            if (prevSigs.contains(revealSig(w))) {
                continue;
            }
            List<String> ids = new ArrayList<>();
            for (Card c : safe(w.cards())) {
                ids.add(c.id());
            }
            if (!ids.isEmpty()) {
                out.add(new RevealEvent(ids, null));
            }
        }
    }

    // --- shuffle / scry / search (protocol §7.1, log-only best-effort) -----------------

    private static void deriveLibraryOps(List<LogEntry> logs, List<GameEvent> out) {
        if (logs == null) {
            return;
        }
        for (LogEntry e : logs) {
            if (e == null || e.text() == null || e.playerId() == null) {
                continue;
            }
            String t = e.text();
            if (ABILITY_TEXT.matcher(t).find()) {
                continue;   // an ability's *description*, not a discrete action
            }
            if (SHUFFLES.matcher(t).find()) {
                out.add(new ShuffleEvent(e.playerId()));
            } else if (SCRIES.matcher(t).find()) {
                out.add(new ScryEvent(e.playerId()));
            } else if (SEARCHES.matcher(t).find()) {
                out.add(new SearchEvent(e.playerId()));
            }
        }
    }

    // --- step -------------------------------------------------------------------------

    private static StepEvent stepEvent(GameState prev, GameState next) {
        GameState.Turn p = prev.turn();
        GameState.Turn n = next.turn();
        var phase = Objects.equals(p.phase(), n.phase()) ? null : n.phase();
        var stp = Objects.equals(p.step(), n.step()) ? null : n.step();
        var active = Objects.equals(p.activePlayerId(), n.activePlayerId()) ? null : n.activePlayerId();
        if (phase == null && stp == null && active == null) {
            return null;
        }
        return new StepEvent(phase, stp, active);
    }

    // --- location maps ----------------------------------------------------------------

    private record Loc(String playerId, Zone zone) {
    }

    private static Map<String, Loc> locMap(GameState state) {
        Map<String, Loc> m = new HashMap<>();
        for (Player p : state.players()) {
            String pid = p.id();
            for (Permanent v : p.battlefield()) {
                m.put(v.id(), new Loc(pid, Zone.BATTLEFIELD));
            }
            for (Card c : p.graveyard()) {
                m.put(c.id(), new Loc(pid, Zone.GRAVEYARD));
            }
            for (Card c : p.exile()) {
                m.put(c.id(), new Loc(pid, Zone.EXILE));
            }
            for (CommandObject c : p.commandZone()) {
                m.put(c.id(), new Loc(pid, Zone.COMMAND));
            }
        }
        if (state.me() != null && state.me().hand() != null) {
            String pid = state.me().playerId();
            for (Card c : state.me().hand()) {
                m.put(c.id(), new Loc(pid, Zone.HAND));
            }
        }
        return m;
    }

    private static Map<String, Permanent> battlefield(GameState state) {
        Map<String, Permanent> m = new HashMap<>();
        for (Player p : state.players()) {
            for (Permanent v : p.battlefield()) {
                m.put(v.id(), v);
            }
        }
        return m;
    }

    private static Map<String, Player> players(GameState state) {
        Map<String, Player> m = new HashMap<>();
        for (Player p : state.players()) {
            m.put(p.id(), p);
        }
        return m;
    }

    private static Map<String, Integer> counterMap(List<Counter> counters) {
        if (counters == null || counters.isEmpty()) {
            return Map.of();
        }
        Map<String, Integer> m = new HashMap<>();
        for (Counter c : counters) {
            m.merge(c.name(), c.count(), Integer::sum);
        }
        return m;
    }

    private static boolean isCombatDamageStep(GameState state) {
        Step s = state.turn().step();
        return s == Step.COMBAT_DAMAGE || s == Step.FIRST_COMBAT_DAMAGE;
    }

    /** Object ids that tapped for mana this delta, from a best-effort "adds {…}"
     *  log scan (the source is the first ref). Advisory — feeds {@code tap.forMana}. */
    private static Set<String> manaSourceIds(List<LogEntry> logs) {
        Set<String> ids = new HashSet<>();
        if (logs == null) {
            return ids;
        }
        for (LogEntry e : logs) {
            if (e == null || e.text() == null || !ADDS_MANA.matcher(e.text()).find()) {
                continue;
            }
            List<LogEntry.Ref> refs = e.refs();
            if (refs != null && !refs.isEmpty()) {
                ids.add(refs.get(0).objectId());
            }
        }
        return ids;
    }

    /** Best-effort {@code playerId → Cause} for life swings: a "loses/gains N life"
     *  line whose player is named and which carries a distinct source ref. */
    private static Map<String, Cause> lifeCauses(List<LogEntry> logs) {
        Map<String, Cause> m = new HashMap<>();
        if (logs == null) {
            return m;
        }
        for (LogEntry e : logs) {
            if (e == null || e.text() == null || e.playerId() == null) {
                continue;
            }
            if (!LOSES_LIFE.matcher(e.text()).find() && !GAINS_LIFE.matcher(e.text()).find()) {
                continue;
            }
            List<LogEntry.Ref> refs = e.refs();
            if (refs == null || refs.isEmpty()) {
                continue;
            }
            LogEntry.Ref src = refs.get(refs.size() - 1);
            if (!src.objectId().equals(e.playerId())) {
                m.putIfAbsent(e.playerId(), new Cause(src.objectId(), src.name(), null));
            }
        }
        return m;
    }

    private static String revealSig(NamedCards w) {
        StringBuilder sb = new StringBuilder(w.name() == null ? "" : w.name()).append('|');
        for (Card c : safe(w.cards())) {
            sb.append(c.id()).append(',');
        }
        return sb.toString();
    }

    private static <T> List<T> safe(List<T> list) {
        return list == null ? List.of() : list;
    }

    private static int nz(Integer v) {
        return v == null ? 0 : v;
    }

    private static void collectTokens(GameState state, Set<String> tokenIds) {
        for (Player p : state.players()) {
            for (Permanent v : p.battlefield()) {
                if (Boolean.TRUE.equals(v.token())) {
                    tokenIds.add(v.id());
                }
            }
        }
    }

    private static Set<String> stackIds(GameState state) {
        Set<String> s = new HashSet<>();
        for (StackItem si : state.stack()) {
            s.add(si.id());
        }
        return s;
    }

    private static String soleDisappeared(Map<String, Loc> prevLoc, Map<String, Loc> nextLoc) {
        String only = null;
        for (String id : prevLoc.keySet()) {
            if (!nextLoc.containsKey(id)) {
                if (only != null) {
                    return null;   // ambiguous — don't guess the stack link
                }
                only = id;
            }
        }
        return only;
    }

    // --- default from/to/verb when the log is silent ----------------------------------

    private static Zone defaultAppearFrom(Zone to) {
        return switch (to) {
            case BATTLEFIELD, EXILE -> Zone.STACK;   // a spell/effect resolved
            case GRAVEYARD, HAND, COMMAND -> Zone.LIBRARY;
            default -> Zone.LIBRARY;
        };
    }

    private static Zone defaultDisappearTo(Zone from) {
        return Zone.LIBRARY;   // hand→library (Brainstorm) is the common unlogged case
    }

    private static Verb defaultVerb(Zone from, Zone to) {
        if (to == Zone.STACK) {
            return Verb.CAST;
        }
        return switch (from) {
            case STACK -> Verb.RESOLVE;   // stack→anywhere is a resolution
            case HAND -> switch (to) {
                case BATTLEFIELD -> Verb.PLAY;
                case GRAVEYARD -> Verb.DISCARD;
                default -> Verb.PUT;
            };
            case BATTLEFIELD -> switch (to) {
                case GRAVEYARD -> Verb.DESTROY;
                case EXILE -> Verb.EXILE;
                case HAND -> Verb.BOUNCE;
                default -> Verb.PUT;
            };
            case LIBRARY -> switch (to) {
                case HAND -> Verb.DRAW;
                case GRAVEYARD -> Verb.MILL;
                default -> Verb.PUT;
            };
            default -> Verb.PUT;   // graveyard→battlefield (reanimate), etc.
        };
    }

    private static Verb verbFor(LogHint h, Zone from, Zone to) {
        return h != null && h.verb() != null ? h.verb() : defaultVerb(from, to);
    }

    private static Cause cause(LogHint h) {
        return h == null ? null : h.cause();
    }

    private static String reason(LogHint h) {
        return h == null ? null : h.reason();
    }

    // --- log parsing ------------------------------------------------------------------

    private record LogHint(String subjectId, Verb verb, Zone from, Zone to, Cause cause, String reason) {
    }

    private record AnonHint(String playerId, Zone from, Zone to, Verb verb, int count) {
    }

    private static void parseLogs(List<LogEntry> logs, List<LogHint> hints, List<AnonHint> anon) {
        if (logs == null) {
            return;
        }
        for (LogEntry e : logs) {
            if (e == null || e.text() == null) {
                continue;
            }
            List<LogEntry.Ref> refs = e.refs() == null ? List.of() : e.refs();
            String text = e.text();
            if (refs.isEmpty()) {
                AnonHint a = anonymous(text, e.playerId());
                if (a != null) {
                    anon.add(a);
                }
                continue;
            }
            LogHint h = hint(text, refs);
            if (h != null) {
                hints.add(h);
            }
        }
    }

    private static LogHint hint(String text, List<LogEntry.Ref> refs) {
        String subject = refs.get(0).objectId();
        Cause src = source(refs, subject);
        Matcher m;
        if ((m = CAST.matcher(text)).find()) {
            return new LogHint(subject, Verb.CAST, zone(m.group(1)), Zone.STACK, src, null);
        }
        if ((m = ONTO_BATTLEFIELD.matcher(text)).find()) {
            Zone from = zone(m.group(1));
            return new LogHint(subject, ontoVerb(from), from, Zone.BATTLEFIELD, src, null);
        }
        if ((m = INTO_GRAVEYARD.matcher(text)).find()) {
            Zone from = zone(m.group(1));
            return new LogHint(subject, intoGraveyardVerb(from), from, Zone.GRAVEYARD, src, null);
        }
        if (DESTROYED_BY.matcher(text).find()) {
            return new LogHint(subject, Verb.DESTROY, Zone.BATTLEFIELD, Zone.GRAVEYARD,
                    causeRef(refs, subject), null);
        }
        if ((m = DIES_FROM.matcher(text)).find()) {
            Zone from = zone(m.group(1));
            String reason = m.group(2) == null ? null : m.group(2).trim();
            return new LogHint(subject, from == Zone.BATTLEFIELD ? Verb.DESTROY : Verb.PUT,
                    from, Zone.GRAVEYARD, null, reason);
        }
        if (SACRIFICED.matcher(text).find()) {
            return new LogHint(subject, Verb.SACRIFICE, Zone.BATTLEFIELD, Zone.GRAVEYARD, src, null);
        }
        if (COUNTERED_BY.matcher(text).find()) {
            return new LogHint(subject, Verb.COUNTER, Zone.STACK, Zone.GRAVEYARD,
                    causeRef(refs, subject), null);
        }
        if ((m = MOVES_ZONE.matcher(text)).find()) {
            Zone from = zone(m.group(1));
            Zone to = zone(m.group(2));
            if (from != null && to != null) {
                return new LogHint(subject, defaultVerb(from, to), from, to, src, null);
            }
        }
        if (RETURNS_HAND.matcher(text).find()) {
            return new LogHint(subject, Verb.BOUNCE, Zone.BATTLEFIELD, Zone.HAND, src, null);
        }
        return null;
    }

    private static AnonHint anonymous(String text, String playerId) {
        Matcher m = DRAWS.matcher(text);
        if (m.find()) {
            return new AnonHint(playerId, Zone.LIBRARY, Zone.HAND, Verb.DRAW, count(m.group(1)));
        }
        if (TUTOR_TO_HAND.matcher(text).find()) {
            return new AnonHint(playerId, Zone.LIBRARY, Zone.HAND, Verb.TUTOR, 1);
        }
        return null;
    }

    /** The card named after {@code source:}/{@code by} — the last ref, when it isn't the subject. */
    private static Cause source(List<LogEntry.Ref> refs, String subject) {
        if (refs.size() < 2) {
            return null;
        }
        LogEntry.Ref last = refs.get(refs.size() - 1);
        return last.objectId().equals(subject) ? null : new Cause(last.objectId(), last.name(), null);
    }

    /** The ref immediately after the subject — the "destroyed by X" / "countered by X" agent. */
    private static Cause causeRef(List<LogEntry.Ref> refs, String subject) {
        if (refs.size() < 2) {
            return null;
        }
        LogEntry.Ref by = refs.get(1);
        return by.objectId().equals(subject) ? null : new Cause(by.objectId(), by.name(), null);
    }

    private static Verb ontoVerb(Zone from) {
        return from == Zone.STACK ? Verb.RESOLVE : from == Zone.HAND ? Verb.PLAY : Verb.PUT;
    }

    private static Verb intoGraveyardVerb(Zone from) {
        return switch (from) {
            case STACK -> Verb.RESOLVE;
            case HAND -> Verb.DISCARD;
            case LIBRARY -> Verb.MILL;
            default -> Verb.PUT;
        };
    }

    private static Zone zone(String s) {
        if (s == null) {
            return null;
        }
        return switch (s.toLowerCase(Locale.ROOT)) {
            case "hand" -> Zone.HAND;
            case "battlefield" -> Zone.BATTLEFIELD;
            case "graveyard" -> Zone.GRAVEYARD;
            case "exile" -> Zone.EXILE;
            case "library" -> Zone.LIBRARY;
            case "stack" -> Zone.STACK;
            case "command" -> Zone.COMMAND;
            default -> null;
        };
    }

    private static int count(String word) {
        if (word == null) {
            return 1;
        }
        String w = word.toLowerCase(Locale.ROOT);
        return switch (w) {
            case "a", "an", "one" -> 1;
            case "two" -> 2;
            case "three" -> 3;
            case "four" -> 4;
            case "five" -> 5;
            case "six" -> 6;
            case "seven" -> 7;
            case "eight" -> 8;
            case "nine" -> 9;
            case "ten" -> 10;
            default -> {
                try {
                    yield Integer.parseInt(w);
                } catch (NumberFormatException ex) {
                    yield 1;
                }
            }
        };
    }
}
