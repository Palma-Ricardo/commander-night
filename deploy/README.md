# Deploying Commander Night

One VPS, two JVMs, one reverse proxy (design.md §2):

```
browser ── wss:// ──► caddy (TLS, public) ── ws://127.0.0.1:8484 ──► night-bridge (JDK 26)
                                                                        │ Java serialization
                                                                        ▼
                                                             xmage server :17171 (bundled JRE 8,
                                                             loopback only)
```

Only caddy is publicly reachable. The lobby code is the only shared secret
(design §10): the perimeter is the host name plus a generated 6-char code.

## Host prerequisites

- Linux with systemd, and caddy installed (distro package or caddyserver.com).
- **JDK 26+** for the bridge (`java -version`). The XMage server uses the
  dist's own bundled JRE 8 — nothing to install for it.
- A DNS A record for your chosen name (e.g. `night.example.com`) pointing at
  the VPS. Caddy provisions the TLS certificate automatically.
- Firewall: allow 80/443 (caddy). Ports 8484 and 17171 stay loopback-bound —
  do not expose them.

## Install

All paths below match the committed unit files; adjust both together if you
deviate.

```sh
# 1. user + directories
sudo useradd --system --home /var/lib/commander-night --create-home commander
sudo mkdir -p /opt/commander-night/bridge /etc/commander-night
sudo chown -R commander:commander /opt/commander-night /var/lib/commander-night

# 2. the XMage dist (from a dev machine; vendor/ is not in git)
rsync -a vendor/xmage-dist/ vps:/opt/commander-night/xmage-dist/

# 3. bind XMage to loopback (the dist ships 0.0.0.0):
#    /opt/commander-night/xmage-dist/xmage/mage-server/config/config.xml
#      <server serverAddress="127.0.0.1" ...
# If the dist was ever run from a different path, also clear any stale
# absolute paths it may have written into its config.

# 4. build + ship the bridge (on the dev machine)
cd bridge && mvn -Pdist -DskipTests package
rsync -a target/night-bridge-*.jar vps:/opt/commander-night/bridge/night-bridge.jar
rsync -a target/lib/ vps:/opt/commander-night/bridge/lib/

# 5. config + units + caddy
scp deploy/bridge.yaml.example vps:/etc/commander-night/bridge.yaml
scp deploy/xmage-server.service deploy/night-bridge.service vps:/etc/systemd/system/
# merge deploy/Caddyfile (with your real hostname) into /etc/caddy/Caddyfile

# 6. start
sudo systemctl daemon-reload
sudo systemctl enable --now xmage-server night-bridge
sudo systemctl reload caddy
```

## Verify

```sh
curl -s http://127.0.0.1:8484/healthz        # on the VPS: bridge + XMage state
curl -s https://night.example.com/healthz    # through caddy from anywhere
```

Then the real check — a browser (or `websocat wss://night.example.com/ws`)
completing `session.hello` → `session.welcome`, and a lobby with `fillAI: true`
playing a full game.

## Operating it

- **Logs:** `journalctl -u night-bridge -f` (bridge, slf4j/logback) and
  `journalctl -u xmage-server -f`. XMage also writes
  `/opt/commander-night/xmage-dist/xmage/mage-server/mageserver.log`
  (grep `"AI player thinks too long"` when AI seats stall).
- **Restart the XMage server between game nights.** 1.4.60 cannot cancel AI
  simulation threads of dead games; they accumulate, burn cores, and skew
  timing (live-observed during M3 validation). `systemctl restart
  xmage-server night-bridge` after everyone's done — never during a game:
  either process dying loses running games (protocol §14).
- **Callback tap** (`callbackTap: true` in bridge.yaml): per-seat capture
  under `/var/lib/commander-night/logs/tap/` — the golden-fixture source and
  the debugging tool of first resort. Off by default in production; a full
  4-player game taps roughly 200 MB per seat.
- **Bridge thread dumps:** `jcmd $(pgrep -f night.bridge.Main)
  Thread.dump_to_file -format=plain /tmp/bridge-threads.txt` — includes
  virtual threads (seat pumps, watchdogs); plain jstack does not.

## Upgrading

- **Bridge only:** rebuild (`mvn -Pdist -DskipTests package`), rsync the jar +
  `lib/`, `systemctl restart night-bridge` (between games).
- **XMage version:** version-pinned (design §1) — replace the whole
  `xmage-dist`, re-run `bridge/install-xmage-jars.sh`, bump `xmage.version`
  in `bridge/pom.xml`, regenerate golden fixtures
  (`mvn test -Dtest=GoldenFixtureTest -Dgolden.regen=true`) and review the
  diff — it shows exactly what the upgrade changed on the wire. Re-pin the
  commander-damage scrape if `CommanderDamageTest` or the fixtures flag drift.
  Then redeploy both dist and bridge together; both sides must be the same
  version or the handshake fails.
