package night.bridge.translate;

import night.bridge.proto.LogEntry;
import night.bridge.proto.event.Cause;
import night.bridge.proto.event.GameEvent;
import night.bridge.proto.event.HiddenEvent;
import night.bridge.proto.event.MoveEvent;
import night.bridge.proto.event.StackLinkEvent;
import night.bridge.proto.event.StepEvent;
import night.bridge.proto.event.Verb;
import night.bridge.proto.event.Zone;
import night.bridge.proto.state.Card;
import night.bridge.proto.state.CommandObject;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.Permanent;
import night.bridge.proto.state.Player;
import night.bridge.proto.state.StackItem;

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

        return out;
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
