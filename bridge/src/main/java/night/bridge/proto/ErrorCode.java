package night.bridge.proto;

/** Protocol §12. Java names double as the wire strings — do not rename. */
public enum ErrorCode {
    UNSUPPORTED_VERSION,
    AUTH_FAILED,
    RESUME_FAILED,
    BAD_MESSAGE,
    UNKNOWN_GAME,
    PROMPT_STALE,
    INVALID_ANSWER,
    DECK_INVALID,
    LOBBY_STATE,
    UPSTREAM_ERROR
}
