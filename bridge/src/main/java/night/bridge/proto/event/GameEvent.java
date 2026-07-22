package night.bridge.proto.event;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

/**
 * Semantic animation events (protocol §7.1) — advisory hints attached to the
 * {@code game.state}/{@code game.patch} they explain. Derived bridge-side (M6)
 * by joining the game log against the state delta; a client reaches the same
 * board from {@code ops} alone and may ignore these entirely (the classic
 * client does). The {@code k} field is the discriminator, exactly as
 * {@code Msg} uses {@code t}.
 *
 * <p>The {@code permits} clause is the subset M6 emits: the zone-motion core
 * ({@code move}, {@code hidden}, {@code stackLink}) plus {@code step}. The
 * protocol freezes further kinds ({@code tap}, {@code attack}, {@code damage},
 * …) for the table client's T4 choreography; they gain records here when the
 * bridge first emits them, and an absent kind reads to a client exactly like an
 * older bridge — no animation for that facet (protocol §7.1, §13).
 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "k")
@JsonSubTypes({
        @JsonSubTypes.Type(value = MoveEvent.class, name = "move"),
        @JsonSubTypes.Type(value = HiddenEvent.class, name = "hidden"),
        @JsonSubTypes.Type(value = StackLinkEvent.class, name = "stackLink"),
        @JsonSubTypes.Type(value = StepEvent.class, name = "step"),
})
public sealed interface GameEvent
        permits MoveEvent, HiddenEvent, StackLinkEvent, StepEvent {
}
