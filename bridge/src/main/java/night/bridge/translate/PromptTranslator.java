package night.bridge.translate;

import mage.players.PlayableObjectStats;
import mage.players.PlayableObjectsList;
import mage.view.GameClientMessage;
import mage.view.GameView;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.state.Card;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Dialog callback payloads → protocol prompts (protocol §15 table; M2 covers
 * confirm, priority, chooseTargets, payMana — the kinds a real game against
 * AIs actually fires; the rest land with the M3 FSM).
 */
public final class PromptTranslator {

    private static final String OPT_YES_TEXT = "UI.left.btn.text";
    private static final String OPT_NO_TEXT = "UI.right.btn.text";
    private static final Pattern PROGRESS = Pattern.compile("selected (\\d+) of (\\d+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern MANA_COST = Pattern.compile("((?:\\{[^}]+\\})+)");

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
     */
    public static GamePrompt priority(long promptId, GameClientMessage msg, GameView view) {
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
        GamePrompt.Progress progress = null;
        Matcher m = PROGRESS.matcher(msg.getMessage() == null ? "" : msg.getMessage());
        if (m.find()) {
            progress = new GamePrompt.Progress(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)));
        }
        boolean required = msg.isFlag();
        int max = progress != null ? progress.of() : 1;
        int min = required ? Math.min(1, max) : 0;
        Serializable zone = msg.getOptions() == null ? null : msg.getOptions().get("targetZone");
        return GamePrompt.chooseTargets(promptId, Html.strip(msg.getMessage()),
                candidates, min, max, required,
                zone == null ? null : zone.toString(), progress, cards);
    }

    /**
     * GAME_PLAY_MANA → payMana. Message is "Pay {cost}" (+ control hints);
     * sources are exactly canPlayObjects (spike-confirmed, 577 samples).
     * Cancel is always available: a boolean(false) aborts the payment.
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
        return GamePrompt.payMana(promptId, text, remaining, sources, true);
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
