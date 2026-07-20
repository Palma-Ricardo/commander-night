package night.bridge.translate;

import night.bridge.proto.GamePrompt;

import java.util.List;
import java.util.Map;
import java.util.function.UnaryOperator;

/**
 * Rewrites XMage's {@code cn_<code>_<n>} usernames to lobby display names in a
 * prompt's player-facing text (protocol §8). {@link ViewTranslator} does the
 * same for state and {@code SeatPump} for log lines; prompts were the gap that
 * shipped raw usernames to a live table on 2026-07-20.
 *
 * <p>Only human-readable strings are touched. Option {@code key}/{@code id},
 * candidate ids and mana {@code sources} are answered back to XMage verbatim,
 * so renaming one would break the reply.
 */
public final class PromptNames {

    /** Returns {@code prompt} itself when nothing changed, so the common case allocates nothing. */
    public static GamePrompt rewrite(GamePrompt p, UnaryOperator<String> rename) {
        if (p == null) {
            return null;
        }
        String message = rename.apply(p.message());
        String zone = rename.apply(p.zone());
        String yesText = rename.apply(p.yesText());
        String noText = rename.apply(p.noText());
        String remaining = rename.apply(p.remaining());
        List<GamePrompt.Option> options = options(p.options(), rename);
        List<GamePrompt.Among> among = among(p.among(), rename);
        Map<String, List<GamePrompt.PlayableAction>> playable = playable(p.playable(), rename);
        GamePrompt.Combat combat = combat(p.combat(), rename);

        if (message == p.message() && zone == p.zone() && yesText == p.yesText()
                && noText == p.noText() && remaining == p.remaining() && options == p.options()
                && among == p.among() && playable == p.playable() && combat == p.combat()) {
            return p;
        }
        return new GamePrompt(p.seq(), p.gameId(), p.promptId(), message, p.kind(),
                yesText, noText, playable, p.canPass(), combat,
                p.candidates(), p.min(), p.max(), p.required(), zone, p.progress(), p.cards(),
                remaining, p.sources(), p.canCancel(), options, p.piles(),
                p.total(), among, p.requestKey());
    }

    private static List<GamePrompt.Option> options(List<GamePrompt.Option> in, UnaryOperator<String> rename) {
        if (in == null) {
            return null;
        }
        List<GamePrompt.Option> out = in.stream()
                .map(o -> {
                    String text = rename.apply(o.text());
                    return text == o.text() ? o : new GamePrompt.Option(o.id(), o.key(), text);
                })
                .toList();
        return changed(in, out) ? out : in;
    }

    private static List<GamePrompt.Among> among(List<GamePrompt.Among> in, UnaryOperator<String> rename) {
        if (in == null) {
            return null;
        }
        List<GamePrompt.Among> out = in.stream()
                .map(a -> {
                    String label = rename.apply(a.label());
                    return label == a.label() ? a
                            : new GamePrompt.Among(a.id(), label, a.min(), a.max(), a.suggested());
                })
                .toList();
        return changed(in, out) ? out : in;
    }

    private static Map<String, List<GamePrompt.PlayableAction>> playable(
            Map<String, List<GamePrompt.PlayableAction>> in, UnaryOperator<String> rename) {
        if (in == null) {
            return null;
        }
        boolean touched = false;
        Map<String, List<GamePrompt.PlayableAction>> out = new java.util.LinkedHashMap<>(in.size());
        for (Map.Entry<String, List<GamePrompt.PlayableAction>> e : in.entrySet()) {
            List<GamePrompt.PlayableAction> actions = e.getValue().stream()
                    .map(a -> {
                        String text = rename.apply(a.text());
                        return text == a.text() ? a : new GamePrompt.PlayableAction(a.kind(), text);
                    })
                    .toList();
            touched |= changed(e.getValue(), actions);
            out.put(e.getKey(), actions);
        }
        return touched ? out : in;
    }

    private static GamePrompt.Combat combat(GamePrompt.Combat in, UnaryOperator<String> rename) {
        if (in == null) {
            return null;
        }
        String special = rename.apply(in.special());
        return special == in.special() ? in
                : new GamePrompt.Combat(in.role(), in.candidates(), in.declared(), special);
    }

    /** Reference-wise, since rename returns the same instance when it changes nothing. */
    private static <T> boolean changed(List<T> before, List<T> after) {
        for (int i = 0; i < before.size(); i++) {
            if (before.get(i) != after.get(i)) {
                return true;
            }
        }
        return false;
    }

    private PromptNames() {
    }
}
