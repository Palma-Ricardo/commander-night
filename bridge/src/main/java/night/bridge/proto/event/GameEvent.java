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
 * <p>The zone-motion core ({@code move}, {@code hidden}, {@code stackLink}) plus
 * {@code step} shipped at M6; the T4 choreography kinds ({@code tap}/{@code untap},
 * {@code attack}/{@code block}, {@code damage}, {@code life}, {@code counters},
 * {@code trigger}, {@code reveal}, {@code shuffle}/{@code scry}/{@code search})
 * are derived alongside them for the table client. An absent kind reads to a
 * client exactly like an older bridge — no animation for that facet, never a
 * correctness change (protocol §7.1, §13).
 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "k")
@JsonSubTypes({
        @JsonSubTypes.Type(value = MoveEvent.class, name = "move"),
        @JsonSubTypes.Type(value = HiddenEvent.class, name = "hidden"),
        @JsonSubTypes.Type(value = StackLinkEvent.class, name = "stackLink"),
        @JsonSubTypes.Type(value = StepEvent.class, name = "step"),
        @JsonSubTypes.Type(value = TapEvent.class, name = "tap"),
        @JsonSubTypes.Type(value = UntapEvent.class, name = "untap"),
        @JsonSubTypes.Type(value = AttackEvent.class, name = "attack"),
        @JsonSubTypes.Type(value = BlockEvent.class, name = "block"),
        @JsonSubTypes.Type(value = DamageEvent.class, name = "damage"),
        @JsonSubTypes.Type(value = LifeEvent.class, name = "life"),
        @JsonSubTypes.Type(value = CountersEvent.class, name = "counters"),
        @JsonSubTypes.Type(value = TriggerEvent.class, name = "trigger"),
        @JsonSubTypes.Type(value = RevealEvent.class, name = "reveal"),
        @JsonSubTypes.Type(value = ShuffleEvent.class, name = "shuffle"),
        @JsonSubTypes.Type(value = ScryEvent.class, name = "scry"),
        @JsonSubTypes.Type(value = SearchEvent.class, name = "search"),
})
public sealed interface GameEvent
        permits MoveEvent, HiddenEvent, StackLinkEvent, StepEvent,
        TapEvent, UntapEvent, AttackEvent, BlockEvent, DamageEvent, LifeEvent,
        CountersEvent, TriggerEvent, RevealEvent, ShuffleEvent, ScryEvent, SearchEvent {
}
