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
# target/lib/ is ~90 MB (measured 2026-07-20). mage-sets-1.4.60.jar alone is ~60 MB of
# that — deck import's CardResolver needs per-card implementation classes, which
# CardInfo#createCard() loads reflectively at runtime, not just the metadata jars the
# bridge compiles against. Trivial next to the ~150 MB card database it sits beside and
# the VPS's 8 GiB RAM / tens of GB disk; not worth trimming.

# 5. build + ship the web client (on the dev machine)
cd client && npm ci && npm run build
rsync -a --delete dist/ vps:/opt/commander-night/client/

# 6. config + units + caddy
scp deploy/bridge.yaml.example vps:/etc/commander-night/bridge.yaml
scp deploy/xmage-server.service deploy/night-bridge.service vps:/etc/systemd/system/
# merge deploy/Caddyfile (with your real hostname) into /etc/caddy/Caddyfile

# 7. card database symlink — deck import resolves card names through XMage's own
#    database, and night.bridge.Main hard-exits if it can't read one (see "Card
#    database access" below). Do this BEFORE the next step: if the bridge starts
#    first, H2 auto-creates an empty, non-symlink `db` directory here and the
#    guard then fails on every restart until that stray directory is removed.
#    `test -L` makes this command safe to re-run even if that already happened.
sudo test -L /var/lib/commander-night/db || sudo rm -rf --one-file-system /var/lib/commander-night/db
sudo ln -sfn /opt/commander-night/xmage-dist/xmage/mage-server/db /var/lib/commander-night/db
sudo chown -h commander:commander /var/lib/commander-night/db

# 8. start
sudo systemctl daemon-reload
sudo systemctl enable --now xmage-server night-bridge
sudo systemctl reload caddy
```

### Card database access (deck import)

The bridge resolves deck card names through XMage's own card database. `CardRepository`
hardcodes the relative path `./db/cards.h2`, so the bridge's working directory needs a symlink —
Install step 7 above creates it before the bridge is ever started. If you need to (re)create it
by hand — e.g. recovering from the stray-directory failure described below — the same command is
safe to re-run:

```sh
sudo test -L /var/lib/commander-night/db || sudo rm -rf --one-file-system /var/lib/commander-night/db
sudo ln -sfn /opt/commander-night/xmage-dist/xmage/mage-server/db /var/lib/commander-night/db
sudo chown -h commander:commander /var/lib/commander-night/db
```

The `test -L` guard matters: `ln -sfn` refuses to replace an *existing directory* named `db` — it
silently (exit 0) creates a symlink named `db` *inside* it instead, so a plain `ln -sfn` retry on
its own never fixes the stray-directory failure below. Removing the non-symlink `db` first
(`--one-file-system` so it cannot cross a mount point into the real XMage installation) is what
makes the command idempotent.

The database is opened in H2 mixed mode (`AUTO_SERVER=TRUE`), so the bridge and the game server
may hold it at the same time; start order between the two *services* does not matter (the symlink
must still exist before either one *first* starts) — `night-bridge.service`'s `Restart=on-failure`
retries every 3 s, so a bridge that starts before XMage has populated the database just comes up
on the next attempt. `AUTO_SERVER=TRUE` does write a lock file on every open, though, even for the
bridge's read-only lookups, and that file lands in the *real* directory the symlink points at,
under `/opt`. `night-bridge.service` already lists that path (not just `/var/lib/commander-night`)
in `ReadWritePaths=` for exactly this reason: opening a file through a symlink is ordinary kernel
path resolution landing the `open()` on the target path, and `ProtectSystem=strict` bind-mounts
everything else read-only — so the target, not just the symlink itself, has to be named in
`ReadWritePaths=` too. If you relocate the XMage dist, update both the symlink target above and
the unit's `ReadWritePaths=` together.

The bridge refuses to start if the table is missing or implausibly small. Two different things
produce that guard:

- **Build-Time mismatch.** `CardRepository`'s constructor drops and rebuilds the card table when
  it thinks the jar is newer than the database, and only the game server's set scanner can
  repopulate it. Start the XMage server once and let it rebuild, then start (or let systemd
  retry) the bridge.
- **Stray auto-created empty db.** If the bridge ever started before the symlink existed, H2
  silently created a real `cards.h2.mv.db` inside a real (non-symlink) `db` directory, and the
  table it opens is simply empty — restarting XMage does not touch that stray file at all.
  Recreate the symlink with the command above (its `test -L` guard removes the stray directory
  first) before restarting the bridge.

## TLS via DNS-01 (Route 53)

The committed Caddyfile solves ACME via DNS-01, so certificate issuance never
depends on inbound port 80 (and works before the A record propagates). That
needs a caddy binary containing the route53 plugin
(`github.com/caddy-dns/route53` v1.6+ — older plugin versions predate caddy
2.10's libdns 1.0 break) plus AWS credentials in caddy's environment.

No distro ships the plugin compiled in, and Fedora/EPEL builds also strip
caddy's self-service commands (`caddy add-package` — verified absent from
EPEL 10's 2.10.2, live on Rocky 10.1). So on every EL release the flow is
the same: keep the EPEL package for its user/unit/dirs, replace the binary
with a plugin-bearing build from the download API.

```sh
sudo dnf install caddy
curl -fL -o /tmp/caddy \
    "https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com%2Fcaddy-dns%2Froute53"
sudo install -m 755 /tmp/caddy /usr/bin/caddy && rm /tmp/caddy
sudo restorecon /usr/bin/caddy
sudo dnf versionlock add caddy
```

The versionlock matters: a routine `dnf update` of the caddy package would
silently reinstate the plugin-less binary — and cert renewal breaks weeks
later. To upgrade caddy, fetch a fresh download-API build.

Credentials: an IAM user whose policy allows only TXT-record changes in the
one hosted zone. Key goes in `/etc/caddy/route53.env` (root:root, mode 600,
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`), loaded via a
drop-in `/etc/systemd/system/caddy.service.d/route53.conf`:

```ini
[Service]
EnvironmentFile=/etc/caddy/route53.env
```

## The web client

Caddy serves the built SPA at `/` and proxies only `/ws` to the bridge
(`deploy/Caddyfile`). The browser derives its WebSocket URL from the page
origin, so there is no host baked into the bundle — the same `dist/` works on
any hostname.

**SELinux.** On Rocky/EL with SELinux enforcing, caddy cannot read a
`file_server` root under `/opt` until it is labelled, and the failure is a
silent 403 rather than an error in caddy's log:

```sh
sudo semanage fcontext -a -t httpd_sys_content_t "/opt/commander-night/client(/.*)?"
sudo restorecon -Rv /opt/commander-night/client
```

(`semanage` comes from `policycoreutils-python-utils`.) Verify with
`curl -I https://your.host/` — a 403 with an empty caddy error log is almost
always this.

**Client and bridge redeploy independently.** They are separate artifacts:

| Changed | Redeploy |
|---|---|
| anything under `client/` | rebuild + rsync `dist/`; no service restart — caddy serves from disk |
| anything under `bridge/` | rebuild + rsync the jar, then `systemctl restart night-bridge` (drops live seats) |
| `deploy/Caddyfile` | `systemctl reload caddy` |

Because `index.html` is served `no-cache`, a client redeploy reaches players
on their next page load. A hard refresh is never required — and if you find
yourself telling someone to hard-refresh, the cache headers are wrong.

## Verify

```sh
curl -s http://127.0.0.1:8484/healthz        # on the VPS: bridge + XMage state
curl -s https://night.example.com/healthz    # through caddy from anywhere
```

Then the real check — a browser (or `websocat wss://night.example.com/ws`)
completing `session.hello` → `session.welcome`, and a lobby with `fillAI: true`
playing a full game. The latter is automated (from a dev machine):

```sh
cd bridge && mvn -Plive test -Dtest=PublicEndpointGameTest \
    -Dnight.publicEndpoint=wss://night.example.com/ws
```

It plays a full auto-answered game through the deployed stack and asserts the
protocol invariants; add `-Dnight.printGameLog=true` to echo the game log.
Restart xmage-server afterwards (AI threads of finished games leak, see below).
On small hosts the CPU-starved AIs win fast — the test seats the aggressive
Zurgo sample deck so combat still fires inside a short game.

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
