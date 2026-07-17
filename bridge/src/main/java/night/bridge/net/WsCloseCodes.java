package night.bridge.net;

/** WebSocket close codes the bridge uses (RFC 6455 §7.4.1). */
final class WsCloseCodes {

    /** 1002: protocol error — unsupported protocol version. */
    static final int PROTOCOL_ERROR = 1002;

    /** 1008: policy violation — connection bumped by a newer one (design §10). */
    static final int POLICY_VIOLATION = 1008;

    /** 1013: try again later — send queue overflow (slow client). */
    static final int OVERLOADED = 1013;

    private WsCloseCodes() {
    }
}
