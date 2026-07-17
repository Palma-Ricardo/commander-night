package night.bridge.proto.state;

/** One counter kind on a card or player (protocol §6). */
public record Counter(String name, int count) {
}
