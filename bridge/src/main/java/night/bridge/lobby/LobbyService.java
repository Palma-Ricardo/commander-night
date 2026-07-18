package night.bridge.lobby;

import mage.cards.decks.DeckCardLists;
import night.bridge.config.Config;
import night.bridge.game.GameCoordinator;
import night.bridge.game.Games;
import night.bridge.game.SeatPump;
import night.bridge.net.SessionRegistry;
import night.bridge.proto.Ack;
import night.bridge.proto.ClientMsg;
import night.bridge.proto.Err;
import night.bridge.proto.ErrorCode;
import night.bridge.proto.LobbyCreate;
import night.bridge.proto.LobbyDeck;
import night.bridge.proto.LobbyJoin;
import night.bridge.proto.LobbyReady;
import night.bridge.proto.LobbyStart;
import night.bridge.proto.LobbyState;
import night.bridge.proto.ServerMsg;
import night.bridge.xmage.SeatSession;
import night.bridge.xmage.TableRecipe;
import night.bridge.xmage.XmageGateway;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import java.util.stream.Stream;

/**
 * Lobbies: code → seats → game (design §9). All lobby state is owned by one
 * single-thread executor (design §4); handlers reply through the caller's
 * connection and broadcast lobby.state through per-user sinks.
 */
public final class LobbyService implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(LobbyService.class);

    /** No 0/O/1/I — the code is read aloud across a room (design §9). */
    private static final String ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private static final int CODE_LENGTH = 6;
    private static final int SEATS = 4;
    private static final long IDLE_EXPIRY_MILLIS = 4L * 60 * 60 * 1000;

    private final ExecutorService exec = Executors.newSingleThreadExecutor(
            Thread.ofVirtual().name("lobby").factory());
    private final SecureRandom random = new SecureRandom();
    private final Map<String, Lobby> byCode = new HashMap<>();
    private final Map<String, Lobby> byUser = new HashMap<>();

    private final SessionRegistry registry;
    private final XmageGateway gateway;
    private final Games games;
    private final Config config;

    private static final class SeatEntry {
        final String userId;
        final String name;
        DeckParser.Parsed deck;
        boolean ready;

        SeatEntry(String userId, String name) {
            this.userId = userId;
            this.name = name;
        }
    }

    private static final class Lobby {
        final String code;
        final String hostUserId;
        final LinkedHashMap<String, SeatEntry> seats = new LinkedHashMap<>();
        boolean started;
        /** Set at launch; the recovery-join path resolves seats through it (design §10). */
        GameCoordinator game;
        long lastTouch = System.currentTimeMillis();

        Lobby(String code, String hostUserId) {
            this.code = code;
            this.hostUserId = hostUserId;
        }
    }

    public LobbyService(SessionRegistry registry, XmageGateway gateway, Games games, Config config) {
        this.registry = registry;
        this.gateway = gateway;
        this.games = games;
        this.config = config;
    }

    /** Jetty-thread entry; {@code reply} is the calling connection's send queue. */
    public void handle(String userId, ClientMsg cmd, Consumer<ServerMsg> reply) {
        exec.execute(() -> {
            try {
                dispatch(userId, cmd, reply);
            } catch (Exception e) {
                log.error("lobby command {} failed", cmd.getClass().getSimpleName(), e);
                reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "internal lobby error"));
            }
            sweepIdle();
        });
    }

    private void dispatch(String userId, ClientMsg cmd, Consumer<ServerMsg> reply) {
        switch (cmd) {
            case LobbyCreate c -> create(userId, c, reply);
            case LobbyJoin c -> join(userId, c, reply);
            case LobbyDeck c -> deck(userId, c, reply);
            case LobbyReady c -> ready(userId, c, reply);
            case LobbyStart c -> start(userId, c, reply);
            default -> reply.accept(Err.re(cmd.id(), ErrorCode.BAD_MESSAGE,
                    "not a lobby command: " + cmd.getClass().getSimpleName()));
        }
    }

    private void create(String userId, LobbyCreate cmd, Consumer<ServerMsg> reply) {
        if (!LobbyCreate.FORMAT_COMMANDER_FFA.equals(cmd.format())) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE,
                    "unsupported format '" + cmd.format() + "' (v1 speaks commander-ffa)"));
            return;
        }
        Lobby existing = byUser.get(userId);
        if (existing != null && !existing.started) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "already in a lobby"));
            return;
        }
        // a started lobby no longer holds its members (protocol §5) — this is the rematch flow
        String code = mintCode();
        Lobby lobby = new Lobby(code, userId);
        byCode.put(code, lobby);
        byUser.put(userId, lobby);
        log.info("lobby {} created by {}", code, userId);
        reply.accept(new Ack(cmd.id()));
        broadcast(lobby); // the creator learns the code from this lobby.state
    }

    private void join(String userId, LobbyJoin cmd, Consumer<ServerMsg> reply) {
        Lobby lobby = byCode.get(cmd.code() == null ? "" : cmd.code().toUpperCase(Locale.ROOT));
        if (lobby == null) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "no lobby with that code"));
            return;
        }
        lobby.lastTouch = System.currentTimeMillis();
        String name = cmd.displayName() == null ? "" : cmd.displayName().strip();
        if (lobby.seats.containsKey(userId)) {
            // The seat is keyed by userId — the name is redundant here, so a
            // blank one must not block a re-bind (design §9).
            reply.accept(new Ack(cmd.id()));
            if (lobby.started) {
                // Same session re-joining its running game — replay it (protocol §14).
                resumeSeat(lobby.game, userId, lobby.code);
            } else {
                // Pre-game reconnect: same session re-binding to its seat (design §9).
                broadcast(lobby);
            }
            return;
        }
        if (name.isEmpty()) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "displayName must not be empty"));
            return;
        }
        if (lobby.started) {
            // Lost-token recovery (design §10): a displayName matching a seated
            // player re-binds that seat to the caller's session, then replays.
            SeatEntry seat = lobby.seats.values().stream()
                    .filter(s -> s.name.equalsIgnoreCase(name))
                    .findFirst().orElse(null);
            if (seat == null) {
                reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE,
                        "game already started (and no seated player is named '" + name + "')"));
                return;
            }
            GameCoordinator game = lobby.game;
            String code = lobby.code;
            log.info("recovery join: '{}' reclaims seat {} in lobby {}", name, seat.userId, code);
            reply.accept(new Ack(cmd.id()));
            registry.adopt(userId, seat.userId, () -> resumeSeat(game, seat.userId, code));
            return;
        }
        Lobby elsewhere = byUser.get(userId);
        if (elsewhere != null && elsewhere != lobby && !elsewhere.started) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "already in another lobby"));
            return;
        }
        boolean nameTaken = lobby.seats.values().stream()
                .anyMatch(s -> s.name.equalsIgnoreCase(name));
        if (nameTaken) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "that name is already seated"));
            return;
        }
        if (lobby.seats.size() >= SEATS) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "lobby is full"));
            return;
        }
        lobby.seats.put(userId, new SeatEntry(userId, name));
        byUser.put(userId, lobby);
        log.info("{} ('{}') joined lobby {}", userId, name, lobby.code);
        reply.accept(new Ack(cmd.id()));
        broadcast(lobby);
    }

    private void deck(String userId, LobbyDeck cmd, Consumer<ServerMsg> reply) {
        SeatEntry seat = seatOf(userId);
        if (seat == null) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "join a lobby seat first"));
            return;
        }
        if (LobbyDeck.FORMAT_LIST.equals(cmd.format())) {
            reply.accept(Err.re(cmd.id(), ErrorCode.DECK_INVALID,
                    "plain-list decks are not supported yet — submit .dck lines: N [SET:NUM] Name, SB: for the commander"));
            return;
        }
        if (!LobbyDeck.FORMAT_DCK.equals(cmd.format())) {
            reply.accept(Err.re(cmd.id(), ErrorCode.DECK_INVALID, "unknown deck format '" + cmd.format() + "'"));
            return;
        }
        if (cmd.content() == null || cmd.content().isBlank()) {
            reply.accept(Err.re(cmd.id(), ErrorCode.DECK_INVALID, "deck content is empty"));
            return;
        }
        Lobby lobby = byUser.get(userId);
        if (lobby.started) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "game already started"));
            return;
        }
        lobby.lastTouch = System.currentTimeMillis();
        seat.deck = DeckParser.parseDck(cmd.content());
        seat.ready = false; // a new deck resets readiness
        reply.accept(new Ack(cmd.id()));
        broadcast(lobby);
    }

    private void ready(String userId, LobbyReady cmd, Consumer<ServerMsg> reply) {
        SeatEntry seat = seatOf(userId);
        if (seat == null) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "join a lobby seat first"));
            return;
        }
        if (cmd.ready() && (seat.deck == null || !seat.deck.valid())) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "submit a valid deck before readying"));
            return;
        }
        Lobby lobby = byUser.get(userId);
        if (lobby.started) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "game already started"));
            return;
        }
        lobby.lastTouch = System.currentTimeMillis();
        seat.ready = cmd.ready();
        reply.accept(new Ack(cmd.id()));
        broadcast(lobby);
    }

    private void start(String userId, LobbyStart cmd, Consumer<ServerMsg> reply) {
        Lobby lobby = byUser.get(userId);
        if (lobby == null) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "not in a lobby"));
            return;
        }
        if (!lobby.hostUserId.equals(userId)) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "only the host starts the game"));
            return;
        }
        if (lobby.started) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "game already started"));
            return;
        }
        if (lobby.seats.isEmpty()) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "no seated players"));
            return;
        }
        for (SeatEntry seat : lobby.seats.values()) {
            if (!seat.ready) {
                reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE,
                        "'" + seat.name + "' is not ready"));
                return;
            }
        }
        int aiSeats = cmd.wantsAiFill() ? SEATS - lobby.seats.size() : 0;
        if (lobby.seats.size() + aiSeats < 2) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE,
                    "need at least 2 players — seat more humans or start with fillAI:true"));
            return;
        }
        launch(lobby, aiSeats, cmd, reply);
    }

    /**
     * The lobby → game transition: one XMage session per human seat, then the
     * spike recipe (design §9). Runs on the lobby executor — table setup takes
     * ~a second against a local server and games start rarely (design §9 accepts
     * this serialization).
     */
    private void launch(Lobby lobby, int aiSeats, LobbyStart cmd, Consumer<ServerMsg> reply) {
        List<DeckCardLists> aiDecks;
        try {
            aiDecks = sampleDecks(aiSeats);
        } catch (IllegalStateException e) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, e.getMessage()));
            return;
        }
        GameCoordinator coordinator = new GameCoordinator(lobby.code, games, gateway,
                config.postGameGraceSecs() * 1000L);
        List<TableRecipe.HumanSeat> recipeSeats = new ArrayList<>();
        long launchMillis = System.currentTimeMillis();
        int n = 0;
        for (SeatEntry seat : lobby.seats.values()) {
            n++;
            SeatSession session = gateway.connectSeat("cn_" + lobby.code + "_" + n);
            if (session == null) {
                coordinator.close();
                reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE,
                        "cannot reach the game server — try again in a moment"));
                return;
            }
            if (config.callbackTap()) {
                session.tap(night.bridge.xmage.CallbackTap.open(
                        Path.of("logs", "tap"),
                        lobby.code + "-" + launchMillis + "-" + session.username()));
            }
            String userId = seat.userId;
            coordinator.addSeat(userId, seat.name, session,
                    registry.sinkFor(userId), config.logBackfill().buffer(),
                    config.logBackfill().send(), config.keyframeEvery(),
                    () -> registry.keyframesOnly(userId));
            recipeSeats.add(new TableRecipe.HumanSeat(session, seat.deck.deck()));
        }
        try {
            TableRecipe.createAndStart("Commander Night " + lobby.code, recipeSeats, aiDecks);
        } catch (TableRecipe.RecipeException e) {
            coordinator.close();
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE,
                    "table setup failed at step: " + e.getMessage()));
            return;
        }
        lobby.started = true;
        lobby.game = coordinator;
        log.info("lobby {} started: {} human(s) + {} AI", lobby.code, lobby.seats.size(), aiSeats);
        reply.accept(new Ack(cmd.id()));
        broadcast(lobby);
    }

    /** AI decks come from the dist's sample Commander decks (spike-proven legal). */
    private List<DeckCardLists> sampleDecks(int n) {
        if (n == 0) {
            return List.of();
        }
        List<DeckCardLists> pool = new ArrayList<>();
        Path dir = Path.of(config.sampleDecksDir());
        try (Stream<Path> files = Files.list(dir)) {
            for (Path file : files.filter(f -> f.toString().endsWith(".dck")).toList()) {
                DeckParser.Parsed parsed = DeckParser.parseDck(Files.readString(file));
                if (parsed.valid()) {
                    pool.add(parsed.deck());
                } else {
                    log.warn("sample deck {} skipped: {}", file.getFileName(), parsed.info().problems());
                }
            }
        } catch (IOException e) {
            throw new IllegalStateException("cannot read sample decks from " + dir, e);
        }
        if (pool.isEmpty()) {
            throw new IllegalStateException("no usable sample decks in " + dir + " for AI seats");
        }
        Collections.shuffle(pool, random);
        List<DeckCardLists> picked = new ArrayList<>(n);
        for (int i = 0; i < n; i++) {
            picked.add(pool.get(i % pool.size()));
        }
        return picked;
    }

    private SeatEntry seatOf(String userId) {
        Lobby lobby = byUser.get(userId);
        return lobby == null ? null : lobby.seats.get(userId);
    }

    /**
     * Replays a seat for a recovered/re-joined session (protocol §14). Runs on
     * the lobby executor or the registry executor (adopt's continuation) —
     * {@code pump.resume} is a thread-safe enqueue either way.
     */
    private void resumeSeat(GameCoordinator game, String seatUserId, String code) {
        SeatPump pump = game == null ? null : game.pumpFor(seatUserId);
        if (pump == null || !pump.resume(-1)) {
            // torn down (or never launched) — the joiner keeps lobby.state only
            log.info("resume for seat {} in lobby {}: game is gone", seatUserId, code);
        }
    }

    private void broadcast(Lobby lobby) {
        List<LobbyState.Seat> seats = new ArrayList<>();
        for (SeatEntry s : lobby.seats.values()) {
            seats.add(new LobbyState.Seat(s.userId, s.name,
                    s.deck == null ? null : s.deck.info(), s.ready));
        }
        LobbyState state = new LobbyState(lobby.code, lobby.hostUserId, seats);
        registry.sinkFor(lobby.hostUserId).send(state);
        for (SeatEntry s : lobby.seats.values()) {
            if (!s.userId.equals(lobby.hostUserId)) {
                registry.sinkFor(s.userId).send(state);
            }
        }
    }

    private String mintCode() {
        while (true) {
            StringBuilder sb = new StringBuilder(CODE_LENGTH);
            for (int i = 0; i < CODE_LENGTH; i++) {
                sb.append(ALPHABET.charAt(random.nextInt(ALPHABET.length())));
            }
            String code = sb.toString();
            if (!byCode.containsKey(code)) {
                return code;
            }
        }
    }

    /**
     * Un-started lobbies idle for 4 h evaporate (design §9); started lobbies
     * follow once their game is over (they only outlive the game to serve
     * recovery joins, which touch {@code lastTouch}).
     */
    private void sweepIdle() {
        long cutoff = System.currentTimeMillis() - IDLE_EXPIRY_MILLIS;
        Iterator<Lobby> it = byCode.values().iterator();
        while (it.hasNext()) {
            Lobby lobby = it.next();
            boolean expirable = !lobby.started || (lobby.game != null && lobby.game.over());
            if (expirable && lobby.lastTouch < cutoff) {
                log.info("lobby {} expired after 4h idle", lobby.code);
                it.remove();
                byUser.remove(lobby.hostUserId, lobby);
                for (String uid : lobby.seats.keySet()) {
                    byUser.remove(uid, lobby);
                }
            }
        }
    }

    @Override
    public void close() {
        exec.close();
    }
}
