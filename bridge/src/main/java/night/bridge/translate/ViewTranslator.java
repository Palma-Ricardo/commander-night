package night.bridge.translate;

import mage.view.CardView;
import mage.view.CardsView;
import mage.view.CombatGroupView;
import mage.view.CommandObjectView;
import mage.view.CommanderView;
import mage.view.CounterView;
import mage.view.DungeonView;
import mage.view.EmblemView;
import mage.view.GameView;
import mage.view.LookedAtView;
import mage.view.ManaPoolView;
import mage.view.PermanentView;
import mage.view.PlaneView;
import mage.view.PlayerView;
import mage.view.RevealedView;
import mage.view.AbilityView;
import mage.view.SimpleCardView;
import mage.view.StackAbilityView;
import night.bridge.proto.state.Card;
import night.bridge.proto.state.Color;
import night.bridge.proto.state.CombatGroup;
import night.bridge.proto.state.CommandObject;
import night.bridge.proto.state.Counter;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.NamedCards;
import night.bridge.proto.state.Permanent;
import night.bridge.proto.state.Phase;
import night.bridge.proto.state.Player;
import night.bridge.proto.state.StackItem;
import night.bridge.proto.state.Step;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.UnaryOperator;

/**
 * GameView → trimmed GameState (protocol §6). The trim rules: maps become
 * ordered arrays, render hints are dropped, interaction hints (choosable /
 * selected / playableStats) are never read — they live in prompts, and
 * derivable strings are dropped. XMage's per-seat filtering is inherited
 * unchanged: whatever this seat's GameView contains is what its browser sees.
 *
 * <p>Commander damage and tax (M5): every card translated in a snapshot runs
 * through the {@link CommanderDamage} scrape, which lifts the watcher's HTML
 * info lines out of the rules text and into structured data. Cast counts
 * attach to the command-zone object they were scraped from; damage entries
 * are collected across all zones and attached to the <em>damaged</em>
 * player's {@code commanderDamage} in a second pass (the line lives on the
 * attacking commander, but the protocol field lives on the victim).
 * {@code Player.timer} stays absent — tables are untimed (design §1).
 */
public final class ViewTranslator {

    /** One seat's snapshot. {@code myPlayerId} may be null before START_GAME resolves it. */
    public static GameState translate(GameView view, String gameId, UUID myPlayerId) {
        return translate(view, gameId, myPlayerId, UnaryOperator.identity());
    }

    /**
     * As above, with player names passed through {@code playerName} — the
     * username → display-name rename (GameCoordinator.displayNames): the wire
     * speaks lobby display names, XMage speaks cn_* usernames.
     */
    public static GameState translate(GameView view, String gameId, UUID myPlayerId,
                                      UnaryOperator<String> playerName) {
        return new ViewTranslator().run(view, gameId, myPlayerId, playerName);
    }

    // One translation pass. Collected while building zones, attached at the end.
    private record ScrapedDamage(String fromCommanderId, String toPlayerName, int amount) {
    }

    private final List<ScrapedDamage> scrapedDamage = new ArrayList<>();
    private final Map<String, Integer> castCountByViewId = new HashMap<>();

    private ViewTranslator() {
    }

    private GameState run(GameView view, String gameId, UUID myPlayerId,
                          UnaryOperator<String> playerName) {
        List<Player> players = new ArrayList<>();
        String priorityPlayerId = null;
        PlayerView myView = null;
        for (PlayerView p : view.getPlayers()) {
            players.add(player(p));
            if (p.hasPriority()) {
                priorityPlayerId = p.getPlayerId().toString();
            }
            if (p.getPlayerId().equals(myPlayerId)) {
                myView = p;
            }
        }
        players.replaceAll(this::attachCommanderDamage);
        // Rename AFTER commander-damage attachment: the scraped damage lines
        // carry XMage's own names, so that equality match must see originals.
        players.replaceAll(p -> renamed(p, playerName));
        return new GameState(
                gameId,
                GameState.Status.ACTIVE,
                view.isRollbackTurnsAllowed(),
                new GameState.Turn(
                        view.getTurn(),
                        phase(view),
                        step(view),
                        view.getActivePlayerId() == null ? null : view.getActivePlayerId().toString(),
                        priorityPlayerId),
                players,
                stack(view),
                combat(view),
                revealed(view),
                lookedAt(view),
                myPlayerId == null ? null
                        : new GameState.Me(myPlayerId.toString(), cardsScraped(view.getMyHand()), skip(myView)));
    }

    /** Protocol §6 {@code me.skip} — only my own skip state goes on the wire (§9 trim). */
    private static GameState.Me.Skip skip(PlayerView p) {
        return p == null ? null
                : skipOf(p.isPassedUntilStackResolved(), p.isPassedUntilEndOfTurn(), p.isPassedUntilNextMain(),
                        p.isPassedAllTurns(), p.isPassedUntilEndStepBeforeMyTurn());
    }

    // At most one flag is set (PlayerImpl resets all before setting any), so order is moot.
    static GameState.Me.Skip skipOf(boolean stack, boolean endOfTurn, boolean nextMain,
                                    boolean myNextTurn, boolean endStepBeforeMyTurn) {
        if (stack) {
            return GameState.Me.Skip.STACK;
        }
        if (endOfTurn) {
            return GameState.Me.Skip.END_OF_TURN;
        }
        if (nextMain) {
            return GameState.Me.Skip.NEXT_MAIN;
        }
        if (myNextTurn) {
            return GameState.Me.Skip.MY_NEXT_TURN;
        }
        if (endStepBeforeMyTurn) {
            return GameState.Me.Skip.END_STEP_BEFORE_MY_TURN;
        }
        return null;
    }

    private static Phase phase(GameView view) {
        // Same constant names on both sides (verified against the 1.4.60 jar).
        return view.getPhase() == null ? null : Phase.valueOf(view.getPhase().name());
    }

    private static Step step(GameView view) {
        if (view.getStep() == null) {
            return null;
        }
        return switch (view.getStep()) {
            case PRECOMBAT_MAIN -> Step.PRE_MAIN;
            case POSTCOMBAT_MAIN -> Step.POST_MAIN;
            default -> Step.valueOf(view.getStep().name());
        };
    }

    private Player player(PlayerView p) {
        List<Permanent> battlefield = new ArrayList<>();
        // A permanent lives under its controller's PlayerView — that IS the
        // controller relation; the view classes carry no controller UUID.
        for (PermanentView v : p.getBattlefield().values()) {
            battlefield.add(permanent(v, p.getPlayerId().toString()));
        }
        return new Player(
                p.getPlayerId().toString(),
                p.getName(),
                p.isHuman(),
                p.getLife(),
                counters(p.getCounters()),
                manaPool(p.getManaPool()),
                p.getLibraryCount(),
                p.getHandCount(),
                battlefield,
                cardsScraped(p.getGraveyard()),
                cardsScraped(p.getExile()),
                commandZone(p.getCommandObjectList()),
                null,           // commanderDamage: attached after all players are scraped
                flags(p),
                null,           // timer: untimed v1
                p.getTopCard() == null ? null : cardScraped(p.getTopCard()));
    }

    /**
     * Second pass: this player's {@code commanderDamage} from damage lines
     * scraped anywhere in the snapshot. Names are XMage's — both the line and
     * {@code PlayerView.getName()} come from the same server, so plain string
     * equality holds. Sorted by commander id for patch-stable ordering.
     */
    private Player attachCommanderDamage(Player p) {
        List<Player.CommanderDamage> dmg = scrapedDamage.stream()
                .filter(d -> d.toPlayerName().equals(p.name()))
                .map(d -> new Player.CommanderDamage(d.fromCommanderId(), d.amount()))
                .distinct()
                .sorted(Comparator.comparing(Player.CommanderDamage::fromCommanderId))
                .toList();
        if (dmg.isEmpty()) {
            return p;
        }
        return new Player(p.id(), p.name(), p.human(), p.life(), p.counters(), p.manaPool(),
                p.librarySize(), p.handSize(), p.battlefield(), p.graveyard(), p.exile(),
                p.commandZone(), dmg, p.flags(), p.timer(), p.topCard());
    }

    private static Player renamed(Player p, UnaryOperator<String> playerName) {
        String display = playerName.apply(p.name());
        if (display.equals(p.name())) {
            return p;
        }
        return new Player(p.id(), display, p.human(), p.life(), p.counters(), p.manaPool(),
                p.librarySize(), p.handSize(), p.battlefield(), p.graveyard(), p.exile(),
                p.commandZone(), p.commanderDamage(), p.flags(), p.timer(), p.topCard());
    }

    private static Player.Flags flags(PlayerView p) {
        boolean monarch = p.isMonarch();
        boolean initiative = p.isInitiative();
        boolean left = p.hasLeft();
        if (!monarch && !initiative && !left) {
            return null;
        }
        return new Player.Flags(monarch ? true : null, initiative ? true : null,
                left ? true : null, null);
    }

    private static Player.ManaPool manaPool(ManaPoolView v) {
        if (v == null) {
            return new Player.ManaPool(0, 0, 0, 0, 0, 0);
        }
        return new Player.ManaPool(v.getWhite(), v.getBlue(), v.getBlack(),
                v.getRed(), v.getGreen(), v.getColorless());
    }

    private List<StackItem> stack(GameView view) {
        List<StackItem> items = new ArrayList<>();
        CardsView stack = view.getStack();
        if (stack == null) {
            return items;
        }
        for (Map.Entry<UUID, CardView> e : stack.entrySet()) {
            CardView cv = e.getValue();
            if (cv instanceof StackAbilityView sav) {
                items.add(new StackItem(
                        e.getKey().toString(),
                        controllerOf(view, sav.getSourceCard()),
                        StackItem.Kind.ABILITY,
                        sav.getSourceCard() == null ? null : cardScraped(sav.getSourceCard()),
                        rules(scrapeOnly(sav.getRules())),
                        ids(sav.getTargets())));
            } else {
                items.add(new StackItem(
                        e.getKey().toString(),
                        null,   // spell views carry no controller (protocol §6 note)
                        StackItem.Kind.SPELL,
                        cardScraped(cv),
                        rules(scrapeOnly(cv.getRules())),
                        ids(cv.getTargets())));
            }
        }
        // XMage's SpellStack is an ArrayDeque pushed at the head, so GameView
        // iterates top→bottom; protocol §6 declares state.stack bottom→top.
        Collections.reverse(items);
        return items;
    }

    /** Best-effort: an ability's source permanent sits on its controller's battlefield. */
    private static String controllerOf(GameView view, CardView source) {
        if (source == null) {
            return null;
        }
        for (PlayerView p : view.getPlayers()) {
            if (p.getBattlefield().containsKey(source.getId())) {
                return p.getPlayerId().toString();
            }
        }
        return null;
    }

    private static List<CombatGroup> combat(GameView view) {
        if (view.getCombat() == null || view.getCombat().isEmpty()) {
            return null;
        }
        List<CombatGroup> groups = new ArrayList<>();
        for (CombatGroupView g : view.getCombat()) {
            groups.add(new CombatGroup(
                    g.getAttackers() == null ? List.of() : g.getAttackers().keySet().stream().map(UUID::toString).toList(),
                    g.getDefenderId() == null ? null : g.getDefenderId().toString(),
                    g.getBlockers() == null ? List.of() : g.getBlockers().keySet().stream().map(UUID::toString).toList(),
                    g.isBlocked()));
        }
        return groups;
    }

    private List<NamedCards> revealed(GameView view) {
        if (view.getRevealed() == null || view.getRevealed().isEmpty()) {
            return null;
        }
        List<NamedCards> windows = new ArrayList<>();
        for (RevealedView r : view.getRevealed()) {
            windows.add(new NamedCards(r.getName(), cardsScraped(r.getCards())));
        }
        return windows;
    }

    private static List<NamedCards> lookedAt(GameView view) {
        if (view.getLookedAt() == null || view.getLookedAt().isEmpty()) {
            return null;
        }
        List<NamedCards> windows = new ArrayList<>();
        for (LookedAtView l : view.getLookedAt()) {
            List<Card> cs = new ArrayList<>();
            if (l.getCards() != null) {
                // LookedAt carries SimpleCardViews: id + set + number only. The
                // client resolves the image from set+number; name is unknown here.
                for (SimpleCardView v : l.getCards().values()) {
                    cs.add(new Card(v.getId().toString(), "", v.getExpansionSetCode(), v.getCardNumber(),
                            null, 0, List.of(), List.of(), List.of(), List.of(), List.of(),
                            null, null, null, null, null, null, null, null, null));
                }
            }
            windows.add(new NamedCards(l.getName(), cs));
        }
        return windows;
    }

    private List<CommandObject> commandZone(List<CommandObjectView> list) {
        List<CommandObject> zone = new ArrayList<>();
        if (list == null) {
            return zone;
        }
        for (CommandObjectView v : list) {
            switch (v) {
                case CommanderView c -> zone.add(commandObject(cardScraped(c), CommandObject.Kind.COMMANDER));
                case EmblemView e -> zone.add(minimalCommandObject(e.getId(), e.getName(),
                        e.getExpansionSetCode(), e.getCardNumber(), e.getRules(), CommandObject.Kind.EMBLEM));
                case PlaneView pl -> zone.add(minimalCommandObject(pl.getId(), pl.getName(),
                        pl.getExpansionSetCode(), null, pl.getRules(), CommandObject.Kind.PLANE));
                case DungeonView d -> zone.add(minimalCommandObject(d.getId(), d.getName(),
                        d.getExpansionSetCode(), null, d.getRules(), CommandObject.Kind.DUNGEON));
                default -> { // unknown command object type: skip rather than fail translation
                }
            }
        }
        return zone;
    }

    private CommandObject commandObject(Card c, CommandObject.Kind kind) {
        return new CommandObject(c.id(), c.name(), c.set(), c.number(), c.manaCost(), c.manaValue(),
                c.types(), c.subtypes(), c.supertypes(), c.colors(), c.text(),
                c.power(), c.toughness(), c.loyalty(), c.defense(), c.counters(),
                c.token(), c.faceDown(), kind, castCountByViewId.get(c.id()));
    }

    private static CommandObject minimalCommandObject(UUID id, String name, String set,
                                                      String number, List<String> rules,
                                                      CommandObject.Kind kind) {
        return new CommandObject(id.toString(), name, set, number, null, 0,
                List.of(), List.of(), List.of(), List.of(), rules(rules),
                null, null, null, null, null, null, null, kind, null);
    }

    private Permanent permanent(PermanentView v, String controllerId) {
        Card c = cardScraped(v);
        return new Permanent(c.id(), c.name(), c.set(), c.number(), c.manaCost(), c.manaValue(),
                c.types(), c.subtypes(), c.supertypes(), c.colors(), c.text(),
                c.power(), c.toughness(), c.loyalty(), c.defense(), c.counters(),
                c.token(), c.faceDown(),
                controllerId,
                v.isTapped(),
                v.isFlipped() ? true : null,
                v.isTransformed() ? true : null,
                morph(v),
                v.getDamage() > 0 ? v.getDamage() : null,
                v.hasSummoningSickness() ? true : null,
                ids(v.getAttachments()),
                v.getAttachedTo() == null ? null : v.getAttachedTo().toString(),
                v.isCopy() ? true : null);
    }

    private static String morph(PermanentView v) {
        if (v.isMorphed()) {
            return "morphed";
        }
        if (v.isManifested()) {
            return "manifested";
        }
        if (v.isDisguised()) {
            return "disguised";
        }
        if (v.isCloaked()) {
            return "cloaked";
        }
        return null;
    }

    /** Instance path: scrape commander info lines and collect their data. */
    private Card cardScraped(CardView v) {
        return cardFrom(v, scrapeOnly(v.getRules(), v.getId().toString()));
    }

    private List<Card> cardsScraped(CardsView cv) {
        List<Card> list = new ArrayList<>();
        if (cv != null) {
            for (CardView v : cv.values()) {
                list.add(cardScraped(v));
            }
        }
        return list;
    }

    private List<String> scrapeOnly(List<String> rawRules) {
        return scrapeOnly(rawRules, null);
    }

    private List<String> scrapeOnly(List<String> rawRules, String viewId) {
        CommanderDamage.Scrape s = CommanderDamage.scrape(rawRules);
        if (viewId != null) {
            if (s.castCount() != null) {
                castCountByViewId.put(viewId, s.castCount());
            }
            s.damageByPlayerName().forEach((name, amount) ->
                    scrapedDamage.add(new ScrapedDamage(viewId, name, amount)));
        }
        return s.remainingRules();
    }

    /**
     * Context-free path for prompt payloads (PromptTranslator): commander info
     * lines are stripped from the text but not collected — prompt cards are
     * not an authoritative scrape site, state is.
     *
     * <p>Trigger-order (and mode-choice) prompts arrive as {@link AbilityView}: a
     * placeholder CardView with name "Ability", no types, and no printing — the real
     * card lives in {@code getSourceCard()}. Render it <em>as</em> that source card
     * (set/number so the client resolves the art, the real name so the player sees
     * which permanent fired) but keep the ability's own rule text, and keep the
     * ability id — that id, not the card id, is what the answer channel round-trips.
     */
    public static Card card(CardView v) {
        if (v instanceof AbilityView av && av.getSourceCard() != null) {
            return cardFrom(av.getSourceCard(),
                    CommanderDamage.scrape(av.getRules()).remainingRules(),
                    av.getId().toString(), true);
        }
        return cardFrom(v, CommanderDamage.scrape(v.getRules()).remainingRules());
    }

    private static Card cardFrom(CardView v, List<String> rawRules) {
        return cardFrom(v, rawRules, v.getId().toString(), false);
    }

    private static Card cardFrom(CardView v, List<String> rawRules, String id, boolean ability) {
        String manaCost = v.getManaCostStr();
        return new Card(
                id,
                v.getName() == null ? "" : v.getName(),
                v.getExpansionSetCode(),
                v.getCardNumber(),
                manaCost == null || manaCost.isBlank() ? null : manaCost,
                v.getManaValue(),
                v.getCardTypes() == null ? List.of() : v.getCardTypes().stream().map(Enum::name).toList(),
                v.getSubTypes() == null ? List.of() : v.getSubTypes().stream().map(Object::toString).toList(),
                v.getSuperTypes() == null ? List.of() : v.getSuperTypes().stream().map(Object::toString).toList(),
                colors(v),
                rules(rawRules),
                blankToNull(v.getPower()),
                blankToNull(v.getToughness()),
                blankToNull(v.getLoyalty()),
                blankToNull(v.getDefense()),
                counters(v.getCounters()),
                v.isToken() ? true : null,
                // Only tokens need it, and only they lack a collector number.
                v.isToken() ? v.getImageNumber() : null,
                v.isFaceDown() ? true : null,
                ability ? Boolean.TRUE : null);
    }

    public static List<Card> cards(CardsView cv) {
        List<Card> list = new ArrayList<>();
        if (cv != null) {
            for (CardView v : cv.values()) {
                list.add(card(v));
            }
        }
        return list;
    }

    private static List<Color> colors(CardView v) {
        if (v.getColor() == null) {
            return List.of();
        }
        List<Color> out = new ArrayList<>(2);
        if (v.getColor().isWhite()) {
            out.add(Color.W);
        }
        if (v.getColor().isBlue()) {
            out.add(Color.U);
        }
        if (v.getColor().isBlack()) {
            out.add(Color.B);
        }
        if (v.getColor().isRed()) {
            out.add(Color.R);
        }
        if (v.getColor().isGreen()) {
            out.add(Color.G);
        }
        return out;
    }

    private static List<Counter> counters(List<CounterView> list) {
        if (list == null || list.isEmpty()) {
            return null;
        }
        return list.stream().map(c -> new Counter(c.getName(), c.getCount())).toList();
    }

    private static List<String> rules(List<String> raw) {
        if (raw == null) {
            return List.of();
        }
        return raw.stream().map(Html::strip).filter(s -> !s.isBlank()).toList();
    }

    private static List<String> ids(List<UUID> raw) {
        if (raw == null || raw.isEmpty()) {
            return null;
        }
        return raw.stream().map(UUID::toString).toList();
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }
}
