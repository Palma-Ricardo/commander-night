package night.bridge.proto.event;

import com.fasterxml.jackson.annotation.JsonValue;

import java.util.Locale;

/**
 * Protocol §7.1 {@code Verb}: how a {@link MoveEvent} looked, so the client can
 * pick the right motion (a destroy topples, a bounce arcs home). Advisory — a
 * wrong verb costs an animation, never correctness (protocol §7.1).
 */
public enum Verb {
    CAST, PLAY, RESOLVE, COUNTER, DESTROY, SACRIFICE, EXILE, DISCARD,
    MILL, BOUNCE, DRAW, TUTOR, PUT, TOKEN, ATTACH, DETACH;

    @JsonValue
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }
}
