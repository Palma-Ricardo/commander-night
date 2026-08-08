package night.bridge.translate;

import mage.choices.Choice;
import mage.constants.Constants;
import mage.constants.PlayerAction;
import mage.players.PlayableObjectStats;
import mage.players.PlayableObjectsList;
import mage.util.MultiAmountMessage;
import mage.view.AbilityPickerView;
import mage.view.GameClientMessage;
import mage.view.GameView;
import mage.view.UserRequestMessage;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.state.Card;
import night.bridge.proto.state.CombatGroup;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.Player;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Dialog callback payloads → protocol prompts (protocol §15 table — all ten
 * kinds as of M3). Prompt payloads are read through typed getters only
 * ({@code getChoices()}, {@code getKeyChoices()}, …) — protocol §15 caveat.
 */
public final class PromptTranslator {

    private static final String OPT_YES_TEXT = "UI.left.btn.text";
    private static final String OPT_NO_TEXT = "UI.right.btn.text";
    // XMage's TargetImpl.getMessage: "Select <name> (selected N of MAX, min MIN)"
    // — "of MAX" present when the max is bounded, ", min MIN" present when min > 0.
    // Both counts and the true minimum are server-side only; we recover them here.
    private static final Pattern PROGRESS =
            Pattern.compile("selected (\\d+)(?: of (\\d+))?(?:, min (\\d+))?", Pattern.CASE_INSENSITIVE);
    // The whole "(selected …)" parenthetical, stripped from the display message: it
    // is XMage's static server-side tally ("selected 0 of 6") that never updates as
    // the client accumulates its scratch selection, so it reads as a stuck "0". The
    // dock's own "Submit k of range" counter is the live source of truth (§8).
    private static final Pattern PROGRESS_SUFFIX =
            Pattern.compile("\\s*\\(selected \\d+(?: of \\d+)?(?:, min \\d+)?\\)", Pattern.CASE_INSENSITIVE);
    private static final Pattern MANA_COST = Pattern.compile("((?:\\{[^}]+\\})+)");
    // MultiAmountMessage rows that name a permanent are built as
    // String.format("%s, P/T: %d/%d", permanent.getLogName(), power, toughness)
    // — CombatGroup.assignDamageToBlockers/assignDamageToAttackers, and the
    // handful of cards that divide damage themselves (Master of the Wild Hunt).
    private static final Pattern ROW_PERMANENT = Pattern.compile(",\\s*P/T:\\s*-?\\d+/-?\\d+\\s*$");
    // GameLog's trailing "[3d2]" id fragment, which rides every log name.
    private static final Pattern ID_SUFFIX = Pattern.compile("\\s*\\[[0-9a-fA-F]{3}\\]\\s*$");

    /** GAME_ASK → confirm. Custom button texts ride the options map (HumanPlayer.chooseUse). */
    public static GamePrompt confirm(long promptId, GameClientMessage msg) {
        return GamePrompt.confirm(promptId, Html.strip(msg.getMessage()),
                option(msg, OPT_YES_TEXT), option(msg, OPT_NO_TEXT));
    }

    /**
     * GAME_SELECT → priority. The playable map comes from GameView.canPlayObjects;
     * PlayableObjectStats exposes only a flattened name list (its per-category
     * lists are package-private), so the mana/play/cast/ability classification
     * is derived from XMage's own ability text conventions. The point of the
     * split is protocol §8's rule: bare mana taps must not read as actions.
     *
     * <p>A GAME_SELECT whose options carry possibleAttackers/possibleBlockers is
     * a combat declaration, not a cast window (HumanPlayer.selectAttackers/
     * selectBlockers accept nothing but toggles) — the prompt then carries
     * {@code combat} and an empty playable map (protocol §8).
     */
    public static GamePrompt priority(long promptId, GameClientMessage msg, GameView view,
                                      GameState state, String myPlayerId) {
        GamePrompt.Combat combat = combat(msg, state, myPlayerId);
        if (combat != null) {
            return GamePrompt.priority(promptId, Html.strip(msg.getMessage()), Map.of(), combat);
        }
        Map<String, List<GamePrompt.PlayableAction>> playable = new LinkedHashMap<>();
        PlayableObjectsList canPlay = view == null ? null : view.getCanPlayObjects();
        if (canPlay != null) {
            for (Map.Entry<UUID, PlayableObjectStats> e : canPlay.getObjects().entrySet()) {
                List<GamePrompt.PlayableAction> actions = new ArrayList<>();
                for (String name : e.getValue().getPlayableAbilityNames()) {
                    actions.add(new GamePrompt.PlayableAction(classify(name), name));
                }
                playable.put(e.getKey().toString(), actions);
            }
        }
        return GamePrompt.priority(promptId, Html.strip(msg.getMessage()), playable);
    }

    private static GamePrompt.Combat combat(GameClientMessage msg, GameState state, String myPlayerId) {
        if (msg.getOptions() == null) {
            return null;
        }
        Serializable attackers = msg.getOptions().get(Constants.Option.POSSIBLE_ATTACKERS);
        Serializable blockers = msg.getOptions().get(Constants.Option.POSSIBLE_BLOCKERS);
        if (attackers == null && blockers == null) {
            return null;
        }
        boolean attacking = attackers != null;
        List<String> candidates = new ArrayList<>();
        for (Object id : (List<?>) (attacking ? attackers : blockers)) {
            candidates.add(id.toString());
        }
        return new GamePrompt.Combat(
                attacking ? GamePrompt.Combat.ATTACKERS : GamePrompt.Combat.BLOCKERS,
                candidates,
                declared(state, myPlayerId, attacking),
                option(msg, Constants.Option.SPECIAL_BUTTON));
    }

    /**
     * The seat's creatures already in combat — the toggle-out half of the ask.
     * POSSIBLE_ATTACKERS/BLOCKERS list only what can still be toggled <em>in</em>
     * (FilterCreatureForCombat excludes attacking creatures), so the current
     * combatants come from the translated state emitted just before this prompt.
     * Filtered to this seat's battlefield: with several defending players,
     * another defender's blockers are in the combat view but not ours to withdraw.
     */
    private static List<String> declared(GameState state, String myPlayerId, boolean attacking) {
        if (state == null || state.combat() == null || myPlayerId == null) {
            return List.of();
        }
        Set<String> mine = new HashSet<>();
        for (Player p : state.players()) {
            if (myPlayerId.equals(p.id())) {
                p.battlefield().forEach(perm -> mine.add(perm.id()));
            }
        }
        Set<String> declared = new LinkedHashSet<>();
        for (CombatGroup g : state.combat()) {
            declared.addAll(attacking ? g.attackerIds() : g.blockerIds());
        }
        declared.retainAll(mine);
        return List.copyOf(declared);
    }

    private static String classify(String abilityText) {
        if (abilityText.startsWith("Cast ")) {
            return GamePrompt.PlayableAction.CAST;
        }
        if (abilityText.startsWith("Play ")) {
            return GamePrompt.PlayableAction.PLAY;
        }
        if (abilityText.contains(": Add ") || abilityText.startsWith("Add ")) {
            return GamePrompt.PlayableAction.MANA;
        }
        return GamePrompt.PlayableAction.ABILITY;
    }

    /**
     * GAME_TARGET → chooseTargets. XMage sends no min/max on this callback —
     * the counts are server-side; "selected X of Y" progress is parsed from
     * the message. min/max here are the client-UI hints protocol §8 promises,
     * reconstructed best-effort: max from progress (single-target otherwise),
     * min 1 when the choice is required.
     */
    public static GamePrompt chooseTargets(long promptId, GameClientMessage msg) {
        List<String> candidates = new ArrayList<>();
        if (msg.getTargets() != null) {
            for (UUID t : msg.getTargets()) {
                candidates.add(t.toString());
            }
        }
        List<Card> cards = null;
        if (msg.getCardsView1() != null && !msg.getCardsView1().isEmpty()) {
            cards = ViewTranslator.cards(msg.getCardsView1());
            if (candidates.isEmpty()) {
                cards.forEach(c -> candidates.add(c.id()));
            }
        }
        String rawMessage = msg.getMessage() == null ? "" : msg.getMessage();
        GamePrompt.Progress progress = null;
        Integer parsedMax = null;
        Integer parsedMin = null;
        Matcher m = PROGRESS.matcher(rawMessage);
        if (m.find()) {
            int chosen = Integer.parseInt(m.group(1));
            parsedMax = m.group(2) == null ? null : Integer.parseInt(m.group(2));
            parsedMin = m.group(3) == null ? null : Integer.parseInt(m.group(3));
            if (parsedMax != null) {
                progress = new GamePrompt.Progress(chosen, parsedMax);
            }
        }
        boolean required = msg.isFlag();
        int max = parsedMax != null ? parsedMax : 1;
        // Prefer XMage's own minimum (parsed above) — it distinguishes a fixed pick
        // (discard exactly 6: min == max) from an "up to" pick, so the client renders
        // the range as "6" not "1–6". Fall back to the required-⇒-1 heuristic only
        // when the message carried no minimum.
        int min = parsedMin != null ? parsedMin : (required ? Math.min(1, max) : 0);
        String message = Html.strip(PROGRESS_SUFFIX.matcher(rawMessage).replaceFirst(""));
        Serializable zone = msg.getOptions() == null ? null : msg.getOptions().get("targetZone");
        return GamePrompt.chooseTargets(promptId, message,
                candidates, min, max, required,
                zone == null ? null : zone.toString(), progress, cards);
    }

    /**
     * GAME_PLAY_MANA → payMana. Message is "Pay {cost}" (+ control hints);
     * sources are exactly canPlayObjects (spike-confirmed, 577 samples).
     * Cancel is always available: a boolean(false) aborts the payment.
     *
     * <p>{@code for} (protocol §8, M7 spike 2026-07-25) is the object whose cost
     * is being paid. The callback carries no source field — its options map is
     * empty ({@code HumanPlayer.playManaHandling}) — but the prompt <em>text</em>
     * does: {@code ManaUtil.addSpecialManaPayAbilities} appends the paying
     * object's log name, and that HTML carries its full UUID
     * ({@link ObjectLink}). Present on 1114/1114 recorded asks, never twice in
     * one ask. Deliberately <b>not</b> the top stack object: a cast card's stack
     * id is ephemeral and not the id clients key the card by, and a "pay {2} or
     * …" cost during someone else's spell has an unrelated stack top.
     */
    public static GamePrompt payMana(long promptId, GameClientMessage msg, GameView view) {
        String text = Html.strip(msg.getMessage());
        Matcher m = MANA_COST.matcher(text);
        String remaining = m.find() ? m.group(1) : null;
        List<String> sources = null;
        PlayableObjectsList canPlay = view == null ? null : view.getCanPlayObjects();
        if (canPlay != null && !canPlay.getObjects().isEmpty()) {
            sources = canPlay.getObjects().keySet().stream().map(UUID::toString).toList();
        }
        String forObject = ObjectLink.sole(msg.getMessage());
        if (forObject == null && ObjectLink.canaryMissed(msg.getMessage())) {
            ObjectLink.warnDrift("payMana", msg.getMessage());
        }
        return GamePrompt.payMana(promptId, text, remaining, sources, true, forObject);
    }

    /**
     * GAME_CHOOSE_ABILITY → chooseAbility. The picker's choices map is a
     * LinkedHashMap (XMage numbers the entries "1. …", "2. …"), so wire order
     * is XMage's order. No source id exists on the view — protocol §8's
     * {@code sourceId} stays absent.
     */
    public static GamePrompt chooseAbility(long promptId, AbilityPickerView picker) {
        List<GamePrompt.Option> options = new ArrayList<>();
        if (picker.getChoices() != null) {
            for (Map.Entry<UUID, String> e : picker.getChoices().entrySet()) {
                options.add(GamePrompt.Option.byId(e.getKey().toString(), Html.strip(e.getValue())));
            }
        }
        return GamePrompt.chooseAbility(promptId, Html.strip(picker.getMessage()), options);
    }

    /**
     * GAME_CHOOSE_CHOICE → chooseOption. Key choices send their key back;
     * plain string choices use the string as its own key (protocol §15: the
     * answer channel is {@code sendPlayerString(choice or key)}). The dialog
     * subtitle is folded into the message (protocol §8). The special
     * "remember answer" mode is not exposed in v1.
     */
    public static GamePrompt chooseOption(long promptId, GameClientMessage msg) {
        Choice choice = msg.getChoice();
        List<GamePrompt.Option> options = new ArrayList<>();
        if (choice.isKeyChoice()) {
            for (Map.Entry<String, String> e : choice.getKeyChoices().entrySet()) {
                options.add(GamePrompt.Option.byKey(e.getKey(), Html.strip(e.getValue())));
            }
        } else if (choice.getChoices() != null) {
            for (String c : choice.getChoices()) {
                options.add(GamePrompt.Option.byKey(c, Html.strip(c)));
            }
        }
        String message = Html.strip(choice.getMessage());
        String sub = choice.getSubMessage();
        if (sub != null && !sub.isBlank()) {
            message = message + " — " + Html.strip(sub);
        }
        return GamePrompt.chooseOption(promptId, message, options, choice.isRequired());
    }

    /** GAME_CHOOSE_PILE → choosePile. Either pile may be empty (protocol §8). */
    public static GamePrompt choosePile(long promptId, GameClientMessage msg) {
        List<Card> pile1 = msg.getCardsView1() == null ? List.of() : ViewTranslator.cards(msg.getCardsView1());
        List<Card> pile2 = msg.getCardsView2() == null ? List.of() : ViewTranslator.cards(msg.getCardsView2());
        return GamePrompt.choosePile(promptId, Html.strip(msg.getMessage()), pile1, pile2);
    }

    /** GAME_GET_AMOUNT → chooseAmount; max Integer.MAX_VALUE passes through (§8). */
    public static GamePrompt chooseAmount(long promptId, GameClientMessage msg) {
        return GamePrompt.chooseAmount(promptId, Html.strip(msg.getMessage()), msg.getMin(), msg.getMax());
    }

    /**
     * GAME_GET_MULTI_AMOUNT → distribute. Rows are positional
     * (MultiAmountMessage carries no ids) — row indexes become the wire ids
     * (protocol §8). The overall message is XMage's dialog header (options
     * "header", falling back to "title"); msg.min/max are the Σ-bounds.
     *
     * <p>{@code objectId} (protocol §8, M7) recovers the object a row divides
     * onto. 1.4.60 builds the object-bearing rows as
     * {@code "<logName>, P/T: p/t"} ({@code CombatGroup.assignDamage*},
     * {@code MasterOfTheWildHunt}), and a log name carries the object's UUID
     * ({@link ObjectLink}) — so the primary derivation is exact, not a guess.
     * Rows without a link fall back to a <em>unique</em> name match against the
     * visible battlefield; two same-named creatures, mana letters ("R"/"G"),
     * counter names and player rows (player log names carry no id) all omit the
     * field, and the client renders those rows as labelled chips.
     */
    public static GamePrompt distribute(long promptId, GameClientMessage msg, GameView view) {
        Map<String, List<String>> byName = battlefieldByName(view);
        List<GamePrompt.Among> among = new ArrayList<>();
        if (msg.getMessages() != null) {
            for (int i = 0; i < msg.getMessages().size(); i++) {
                MultiAmountMessage m = msg.getMessages().get(i);
                among.add(new GamePrompt.Among(String.valueOf(i), Html.strip(m.message),
                        m.min, m.max, m.defaultValue, rowObject(m.message, byName)));
            }
        }
        String message = option(msg, "header");
        if (message == null) {
            message = option(msg, "title");
        }
        boolean canCancel = msg.getOptions() != null
                && Boolean.TRUE.equals(msg.getOptions().get("canCancel"));
        return GamePrompt.distribute(promptId, Html.strip(message),
                msg.getMax(), msg.getMin(), among, canCancel);
    }

    /** The object a distribute row divides onto, or null when not resolvable. */
    private static String rowObject(String rawLabel, Map<String, List<String>> byName) {
        String linked = ObjectLink.sole(rawLabel);
        if (linked != null) {
            return linked;
        }
        String name = rowName(rawLabel);
        List<String> hits = name.isEmpty() ? List.of() : byName.getOrDefault(name, List.of());
        if (hits.size() == 1) {
            return hits.getFirst();
        }
        if (hits.isEmpty() && rawLabel != null && ROW_PERMANENT.matcher(rawLabel).find()) {
            // Shaped like a permanent row, yet neither the link nor the name resolved:
            // either an XMage upgrade moved the strings, or the object left the board.
            ObjectLink.warnDrift("distribute row", rawLabel);
        }
        return null;                    // ambiguous (two same-named creatures) or no object
    }

    /** A row label's bare object name: HTML stripped, the pinned P/T suffix dropped. */
    private static String rowName(String rawLabel) {
        String text = Html.strip(rawLabel);
        Matcher m = ROW_PERMANENT.matcher(text);
        if (m.find()) {
            text = text.substring(0, m.start());
        }
        return ID_SUFFIX.matcher(text).replaceFirst("").strip();
    }

    /** Visible permanent names → ids, across every seat's battlefield. */
    private static Map<String, List<String>> battlefieldByName(GameView view) {
        if (view == null || view.getPlayers() == null) {
            return Map.of();
        }
        Map<String, List<String>> byName = new LinkedHashMap<>();
        for (var player : view.getPlayers()) {
            if (player.getBattlefield() == null) {
                continue;
            }
            player.getBattlefield().forEach((id, perm) -> {
                String name = perm.getName();
                if (name != null && !name.isBlank()) {
                    byName.computeIfAbsent(name, k -> new ArrayList<>()).add(id.toString());
                }
            });
        }
        return byName;
    }

    /**
     * USER_REQUEST_DIALOG → playerRequest. Buttons become options keyed by
     * their PlayerAction name — the FSM sends the action back — or "dismiss"
     * for a button with no action (close-only). requestKey = dialog title
     * (protocol §8: XMage sends no machine key).
     */
    public static GamePrompt playerRequest(long promptId, UserRequestMessage msg) {
        List<GamePrompt.Option> options = new ArrayList<>();
        addButton(options, msg.getButton1Text(), msg.getButton1Action());
        addButton(options, msg.getButton2Text(), msg.getButton2Action());
        addButton(options, msg.getButton3Text(), msg.getButton3Action());
        return GamePrompt.playerRequest(promptId, Html.strip(msg.getMessage()),
                Html.strip(msg.getTitle()), options);
    }

    private static void addButton(List<GamePrompt.Option> options, String text, PlayerAction action) {
        if (text != null) {
            options.add(GamePrompt.Option.byKey(action == null ? "dismiss" : action.name(),
                    Html.strip(text)));
        }
    }

    private static String option(GameClientMessage msg, String key) {
        if (msg.getOptions() == null) {
            return null;
        }
        Serializable v = msg.getOptions().get(key);
        return v == null ? null : v.toString();
    }

    private PromptTranslator() {
    }
}
