# Protocol v1 conformance corpus

One canonical JSON sample per message shape (`docs/protocol/v1.md` is normative for the
shapes; these files are normative for the *bytes* both codebases must agree on).

- The bridge asserts against this corpus in `ProtocolSamplesTest`: client → server samples
  must **decode**; server → client samples must be **byte-for-byte reproducible** (modulo
  key order) from the bridge's own message types.
- The TS client's tests will assert the mirror image (produce the client → server samples,
  parse the server → client ones), so the two codebases never drift silently (design §13).

Naming: `<wire-type>[.variant].json`. Grows with each milestone; M1 seeds the session layer.
