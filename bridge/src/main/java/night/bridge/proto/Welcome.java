package night.bridge.proto;

/**
 * Reply to a successful hello (protocol §4). {@code token} is present on
 * fresh sessions only — the bridge-minted session token the client persists
 * and presents on every later hello (§16.6).
 */
public record Welcome(
        String re,
        int v,
        String userId,
        String token,
        Role role,
        boolean resumed) implements ServerMsg {
}
