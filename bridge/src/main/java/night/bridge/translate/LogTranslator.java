package night.bridge.translate;

import mage.view.ChatMessage;
import night.bridge.proto.LogEntry;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * CHATMESSAGE → game.log lines (protocol §10). ORANGE messages are XMage's
 * turn/match-structure announcements — 100 % derivable from state, dropped.
 * Card references arrive as HTML attributes ({@code object_id='<uuid>'});
 * they are lifted into {@code refs} so the client can link log lines to cards.
 */
public final class LogTranslator {

    private static final Pattern REF = Pattern.compile("object_id='([^']+)'[^>]*>([^<]+)");

    /** A log line before the pump stamps seq/ts/playerId. */
    public record Line(LogEntry.Kind kind, String turn, String text,
                       List<LogEntry.Ref> refs, String username) {
    }

    public static Optional<Line> chat(ChatMessage msg) {
        if (msg.getColor() == ChatMessage.MessageColor.ORANGE) {
            return Optional.empty();
        }
        LogEntry.Kind kind = switch (msg.getMessageType()) {
            case GAME -> LogEntry.Kind.GAME;
            case TALK, WHISPER_FROM, WHISPER_TO -> LogEntry.Kind.CHAT;
            case STATUS, USER_INFO -> LogEntry.Kind.STATUS;
        };
        String text = Html.strip(msg.getMessage());
        if (text.isBlank()) {
            return Optional.empty();
        }
        return Optional.of(new Line(kind,
                blankToNull(msg.getTurnInfo()),
                text,
                refs(msg.getMessage()),
                blankToNull(msg.getUsername())));
    }

    private static List<LogEntry.Ref> refs(String html) {
        if (html == null || !html.contains("object_id")) {
            return null;
        }
        List<LogEntry.Ref> refs = new ArrayList<>();
        Matcher m = REF.matcher(html);
        while (m.find()) {
            refs.add(new LogEntry.Ref(m.group(1), Html.strip(m.group(2))));
        }
        return refs.isEmpty() ? null : refs;
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }

    private LogTranslator() {
    }
}
