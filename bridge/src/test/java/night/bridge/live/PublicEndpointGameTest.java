package night.bridge.live;

import night.bridge.live.LiveHarness.Client;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.net.URI;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The deploy runbook's last verify step (docs/deploy/README.md): the same
 * full-game auto-player and invariant auditor as {@link LiveGameTest}, but
 * pointed at a deployed bridge's public endpoint — DNS, caddy's TLS and
 * WebSocket proxying, and the production units in the loop instead of an
 * in-process app.
 *
 * <p>Opt-in and endpoint-parameterized; skipped when the property is unset:
 * {@code mvn -Plive test -Dtest=PublicEndpointGameTest
 * -Dnight.publicEndpoint=wss://night.example.com/ws}
 *
 * <p>Restart xmage-server on the host afterwards (docs/deploy/README.md): 1.4.60
 * leaks AI simulation threads from finished games.
 */
@Tag("live")
class PublicEndpointGameTest {

    @Test
    @Timeout(value = 30, unit = TimeUnit.MINUTES)
    void fullGameThroughPublicEndpoint() throws Exception {
        String endpoint = System.getProperty("night.publicEndpoint", "");
        assumeTrue(!endpoint.isBlank(), "-Dnight.publicEndpoint=wss://host/ws required");
        // Zurgo, not Tasigur: on a small prod host the CPU-starved AIs play fast
        // and games run short, so the combat-declaration assertion needs a deck
        // that fights early — 2/2 Tasigur runs ended combat-less (2026-07-18)
        LiveHarness.playFullGame(Client.connect(URI.create(endpoint), "public"),
                LiveHarness.AGGRO_DECK);
    }
}
