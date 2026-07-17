package night.bridge.proto.state;

import com.fasterxml.jackson.annotation.JsonValue;

import java.util.List;
import java.util.Locale;

/**
 * Protocol §6 {@code StackItem}: a spell or ability on the stack.
 * {@code card} is the spell itself, or the ability's source card for context.
 */
public record StackItem(
        String id,
        String controllerId,
        Kind kind,
        Card card,
        List<String> text,
        List<String> targets) {

    public enum Kind {
        SPELL, ABILITY;

        @JsonValue
        public String wire() {
            return name().toLowerCase(Locale.ROOT);
        }
    }
}
