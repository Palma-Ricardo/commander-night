package night.bridge.proto.event;

import com.fasterxml.jackson.annotation.JsonValue;

import java.util.Locale;

/** Protocol §7.1 {@code Zone}: the source/destination of a {@link MoveEvent}. */
public enum Zone {
    HAND, BATTLEFIELD, GRAVEYARD, EXILE, LIBRARY, STACK, COMMAND;

    @JsonValue
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }
}
