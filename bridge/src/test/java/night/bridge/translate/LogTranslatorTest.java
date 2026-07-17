package night.bridge.translate;

import mage.view.ChatMessage;
import night.bridge.proto.LogEntry;
import org.junit.jupiter.api.Test;

import java.util.Date;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LogTranslatorTest {

    private static ChatMessage msg(String user, String text, ChatMessage.MessageColor color,
                                   ChatMessage.MessageType type) {
        return new ChatMessage(user, text, new Date(), null, color, type, null);
    }

    @Test
    void orangeStructureAnnouncementsAreDropped() {
        assertTrue(LogTranslator.chat(msg(null, "Turn 3 of ai_1",
                ChatMessage.MessageColor.ORANGE, ChatMessage.MessageType.GAME)).isEmpty());
    }

    @Test
    void gameLogLineIsStrippedAndRefsExtracted() {
        String html = "Ricardo casts <font color='#5aff aa'><a href='#' object_id='3f2a9d1e-6c47-4b2e-9a10-8e5d21f7b0c4'>Arcane Signet</a></font>";
        Optional<LogTranslator.Line> line = LogTranslator.chat(
                msg(null, html, ChatMessage.MessageColor.BLACK, ChatMessage.MessageType.GAME));
        assertTrue(line.isPresent());
        assertEquals(LogEntry.Kind.GAME, line.get().kind());
        assertEquals("Ricardo casts Arcane Signet", line.get().text());
        assertEquals(1, line.get().refs().size());
        assertEquals("3f2a9d1e-6c47-4b2e-9a10-8e5d21f7b0c4", line.get().refs().getFirst().objectId());
        assertEquals("Arcane Signet", line.get().refs().getFirst().name());
    }

    @Test
    void talkBecomesChatWithSpeaker() {
        Optional<LogTranslator.Line> line = LogTranslator.chat(
                msg("Ricardo", "hello table", ChatMessage.MessageColor.BLUE, ChatMessage.MessageType.TALK));
        assertEquals(LogEntry.Kind.CHAT, line.orElseThrow().kind());
        assertEquals("Ricardo", line.get().username());
        assertNull(line.get().refs());
    }

    @Test
    void blankAfterStrippingIsDropped() {
        assertTrue(LogTranslator.chat(msg(null, "<font color='#000000'> </font>",
                ChatMessage.MessageColor.BLACK, ChatMessage.MessageType.GAME)).isEmpty());
    }

    @Test
    void htmlStripHandlesEntitiesAndBreaks() {
        assertEquals("Ping & pong: 2 > 1", Html.strip("Ping &amp; pong:<br>2 &gt; 1"));
        assertEquals("", Html.strip(null));
    }
}
