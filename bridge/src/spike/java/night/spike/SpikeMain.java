package night.spike;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import mage.cards.decks.DeckCardInfo;
import mage.cards.decks.DeckCardLists;
import mage.choices.Choice;
import mage.constants.ManaType;
import mage.constants.MultiplayerAttackOption;
import mage.constants.PlayerAction;
import mage.constants.RangeOfInfluence;
import mage.game.match.MatchOptions;
import mage.interfaces.MageClient;
import mage.interfaces.callback.ClientCallback;
import mage.players.PlayableObjectStats;
import mage.players.PlayerType;
import mage.remote.Connection;
import mage.remote.Session;
import mage.remote.SessionImpl;
import mage.util.MultiAmountMessage;
import mage.utils.MageVersion;
import mage.view.AbilityPickerView;
import mage.view.ChatMessage;
import mage.view.CommandObjectView;
import mage.view.GameClientMessage;
import mage.view.GameEndView;
import mage.view.GameView;
import mage.view.ManaPoolView;
import mage.view.PlayerView;
import mage.view.SimpleCardView;
import mage.view.TableClientMessage;
import mage.view.TableView;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Commander Night bridge spike, phase 2: prompt coverage.
 *
 * Connects to a local XMage server as a headless client, creates a Commander
 * Free For All table, seats itself plus three AI players, starts the match,
 * and streams every server callback to a JSON-lines log.
 *
 * Unlike phase 1 (which auto-passed everything), this client plays GREEDILY:
 * on priority it acts on the first playable object, pays mana by hand
 * (auto-payment is switched off to force GAME_PLAY_MANA), answers every
 * dialog with a first-legal choice, and joins the game chat. Goal: capture
 * real payloads for the dialog callbacks the AI-only game never sent
 * (PLAY_MANA, PLAY_XMANA, CHOOSE_ABILITY, CHOOSE_PILE, GET_MULTI_AMOUNT,
 * CHATMESSAGE, DFC/split/adventure card views).
 *
 * Run with --pass for the old phase-1 auto-pass behavior.
 *
 * Modeled on XMage's own headless test client:
 * Mage.Tests/src/test/java/org/mage/test/load/{SimpleMageClient,LoadCallbackClient,LoadTest}.java
 */
public final class SpikeMain {

    private static final String HOST = "127.0.0.1";
    private static final int PORT = 17171;
    private static final String GAME_TYPE = "Commander Free For All";
    private static final String DECK_TYPE = "Variant Magic - Commander";
    private static final long MAX_GAME_MILLIS = 45L * 60 * 1000;

    public static void main(String[] args) throws Exception {
        boolean greedy = true;
        for (String arg : args) {
            if ("--pass".equals(arg)) {
                greedy = false;
            }
        }

        String distDecks = "vendor/xmage-dist/xmage/mage-client/sample-decks/Commander/";
        String[] deckFiles = {
                "bridge/decks/coverage_bgu.dck",           // bridge (greedy actor; Tasigur + dialog-forcing swaps)
                distDecks + "Tasigur BGU.dck",             // ai_1
                distDecks + "Geoff's Daxos of Meletis.dck",// ai_2
                distDecks + "Zurgo Helmsmasher RWB.dck",   // ai_3
        };

        File logDir = new File("bridge/logs");
        logDir.mkdirs();
        File logFile = new File(logDir, "spike-" + System.currentTimeMillis() + ".jsonl");
        JsonEventLog eventLog = new JsonEventLog(logFile);
        System.out.println("[spike] mode=" + (greedy ? "greedy" : "pass") + ", logging to " + logFile.getPath());

        DeckCardLists[] decks = new DeckCardLists[4];
        for (int i = 0; i < 4; i++) {
            decks[i] = parseDck(deckFiles[i]);
            System.out.println("[spike] deck " + i + ": " + deckFiles[i]
                    + " main=" + decks[i].getCards().size()
                    + " sb=" + decks[i].getSideboard().size());
        }

        BridgeClient client = new BridgeClient(eventLog, greedy);
        Session session = new SessionImpl(client);
        client.setSession(session);

        Connection connection = new Connection();
        connection.setUsername("night_bridge");
        connection.setHost(HOST);
        connection.setPort(PORT);
        connection.setProxyType(Connection.ProxyType.NONE);

        System.out.println("[spike] connecting to " + HOST + ":" + PORT + " ...");
        if (!session.connectStart(connection)) {
            System.err.println("[spike] FAILED to connect (is the local server running?)");
            System.exit(1);
        }
        System.out.println("[spike] connected, server version ok");

        UUID roomId = session.getMainRoomId();

        MatchOptions options = new MatchOptions("Commander Night spike", GAME_TYPE, false);
        options.getPlayerTypes().add(PlayerType.HUMAN);
        options.getPlayerTypes().add(PlayerType.COMPUTER_MAD);
        options.getPlayerTypes().add(PlayerType.COMPUTER_MAD);
        options.getPlayerTypes().add(PlayerType.COMPUTER_MAD);
        options.setDeckType(DECK_TYPE);
        options.setLimited(false);
        options.setAttackOption(MultiplayerAttackOption.MULTIPLE);
        options.setRange(RangeOfInfluence.ALL);
        options.setWinsNeeded(1);

        TableView table = session.createTable(roomId, options);
        UUID tableId = table.getTableId();
        System.out.println("[spike] table created: " + tableId);

        for (int i = 1; i <= 3; i++) {
            if (!session.joinTable(roomId, tableId, "ai_" + i, PlayerType.COMPUTER_MAD, 5, decks[i], "")) {
                System.err.println("[spike] FAILED to seat ai_" + i + " (deck invalid?)");
                System.exit(1);
            }
            System.out.println("[spike] seated ai_" + i);
        }
        if (!session.joinTable(roomId, tableId, "night_bridge", PlayerType.HUMAN, 1, decks[0], "")) {
            System.err.println("[spike] FAILED to seat bridge player (coverage deck invalid?)");
            System.exit(1);
        }
        System.out.println("[spike] seated bridge player");

        if (!session.startMatch(roomId, tableId)) {
            System.err.println("[spike] FAILED to start match");
            System.exit(1);
        }
        System.out.println("[spike] match started, playing until game over ...");

        long start = System.currentTimeMillis();
        long lastPing = start;
        while (!client.isGameOver() && (System.currentTimeMillis() - start) < MAX_GAME_MILLIS) {
            Thread.sleep(2000);
            if (System.currentTimeMillis() - lastPing > 10000) {
                session.ping();
                lastPing = System.currentTimeMillis();
            }
            if (!session.isConnected()) {
                System.err.println("[spike] lost connection to server");
                break;
            }
        }

        eventLog.close();
        boolean finished = client.isGameOver();
        System.out.println("[spike] " + (finished ? "GAME OVER" : "TIMEOUT / DISCONNECT")
                + " after " + ((System.currentTimeMillis() - start) / 1000) + "s"
                + ", " + eventLog.count() + " callbacks logged"
                + ", turns seen: " + client.getLastTurn()
                + ", actions taken: " + client.getTotalActions());
        System.out.println("[spike] log: " + logFile.getPath());
        session.connectStop(false, false);
        System.exit(finished ? 0 : 2);
    }

    /**
     * Minimal .dck parser: "N [SET:NUM] Name" lines, "SB:" prefix = sideboard
     * (where the commander lives). Avoids CardRepository/DeckImporter so the
     * bridge needs no local card database.
     */
    private static DeckCardLists parseDck(String path) throws Exception {
        Pattern line = Pattern.compile("^(SB:\\s*)?(\\d+)\\s+\\[([^:\\]]+):([^\\]]+)\\]\\s+(.+?)\\s*$");
        DeckCardLists deck = new DeckCardLists();
        BufferedReader reader = new BufferedReader(new FileReader(path));
        try {
            String s;
            while ((s = reader.readLine()) != null) {
                Matcher m = line.matcher(s);
                if (!m.matches()) {
                    continue; // NAME:/AUTHOR:/LAYOUT/blank lines
                }
                boolean sideboard = m.group(1) != null;
                int amount = Integer.parseInt(m.group(2));
                String setCode = m.group(3);
                String cardNumber = m.group(4);
                String cardName = m.group(5);
                for (int i = 0; i < amount; i++) {
                    DeckCardInfo info = new DeckCardInfo(cardName, cardNumber, setCode);
                    if (sideboard) {
                        deck.getSideboard().add(info);
                    } else {
                        deck.getCards().add(info);
                    }
                }
            }
        } finally {
            reader.close();
        }
        return deck;
    }

    /** Writes one JSON object per line: {seq, ts, method, objectId, dataClass, data}. */
    static final class JsonEventLog {
        private final Gson gson = new GsonBuilder().disableHtmlEscaping().create();
        private final BufferedWriter out;
        private long seq = 0;

        JsonEventLog(File file) throws Exception {
            this.out = new BufferedWriter(new FileWriter(file));
        }

        synchronized void logCallback(ClientCallback callback) {
            Map<String, Object> record = new LinkedHashMap<String, Object>();
            record.put("seq", seq++);
            record.put("ts", System.currentTimeMillis());
            record.put("method", String.valueOf(callback.getMethod()));
            record.put("objectId", String.valueOf(callback.getObjectId()));
            Object data = callback.getData();
            record.put("dataClass", data == null ? null : data.getClass().getName());
            write(record, data);
        }

        synchronized void logResponse(String kind, Object answer) {
            Map<String, Object> record = new LinkedHashMap<String, Object>();
            record.put("seq", seq++);
            record.put("ts", System.currentTimeMillis());
            record.put("method", "BRIDGE_RESPONSE");
            record.put("kind", kind);
            record.put("answer", String.valueOf(answer));
            write(record, null);
        }

        private void write(Map<String, Object> record, Object data) {
            try {
                String dataJson = null;
                if (data != null) {
                    try {
                        dataJson = gson.toJson(data);
                    } catch (Throwable e) {
                        record.put("dataSerializationError", e.toString());
                        record.put("dataToString", String.valueOf(data));
                    }
                }
                StringBuilder sb = new StringBuilder(gson.toJson(record));
                if (dataJson != null) {
                    // splice raw data json so it stays structured, not double-encoded
                    sb.setLength(sb.length() - 1);
                    sb.append(",\"data\":").append(dataJson).append('}');
                }
                out.write(sb.toString());
                out.newLine();
                out.flush();
            } catch (Exception e) {
                System.err.println("[spike] log write failed: " + e);
            }
        }

        synchronized long count() {
            return seq;
        }

        synchronized void close() throws Exception {
            out.flush();
            out.close();
        }
    }

    /**
     * Headless MageClient: logs every callback and (in greedy mode) plays the
     * first legal action at every decision point so the server is forced to
     * exercise its full dialog vocabulary.
     */
    static final class BridgeClient implements MageClient {
        /** Stop initiating new plays after this many, so a degenerate loop can't run away. */
        private static final long MAX_ACTIONS = 400;
        /** Give up on a repeating identical prompt after this many rounds. */
        private static final int MAX_PROMPT_REPEATS = 20;

        private final MageVersion version = new MageVersion(MageClient.class);
        private final JsonEventLog eventLog;
        private final boolean greedy;
        private volatile Session session;
        private volatile UUID gameId;
        private volatile UUID playerId;
        private volatile GameView gameView;
        private volatile boolean gameOver;
        private volatile int quietSeconds;
        private volatile boolean watchdogStarted;

        // greedy-actor state (only touched from the synchronized callback path)
        private final Set<UUID> actedThisTurn = new HashSet<UUID>();
        private final Set<UUID> clickedThisPrompt = new HashSet<UUID>();
        private int lastSeenTurn = -1;
        private long totalActions = 0;
        private String lastPromptKey = "";
        private int promptRepeats = 0;
        private boolean abilityPickerToggle = false;

        BridgeClient(JsonEventLog eventLog, boolean greedy) {
            this.eventLog = eventLog;
            this.greedy = greedy;
        }

        void setSession(Session session) {
            this.session = session;
        }

        boolean isGameOver() {
            return gameOver;
        }

        int getLastTurn() {
            GameView view = gameView;
            return view == null ? 0 : view.getTurn();
        }

        long getTotalActions() {
            return totalActions;
        }

        @Override
        public MageVersion getVersion() {
            return version;
        }

        @Override
        public void connected(String message) {
            System.out.println("[spike] server: connected: " + message);
        }

        @Override
        public void disconnected(boolean askToReconnect, boolean keepMySessionActive) {
            System.out.println("[spike] server: disconnected");
        }

        @Override
        public void showMessage(String message) {
            System.out.println("[spike] server message: " + message);
        }

        @Override
        public void showError(String message) {
            System.err.println("[spike] server error: " + message);
        }

        @Override
        public void onNewConnection() {
            // single connection, nothing to reset
        }

        @Override
        public synchronized void onCallback(ClientCallback callback) {
            try {
                callback.decompressData();
                quietSeconds = 0;
                eventLog.logCallback(callback);
                handle(callback);
            } catch (Throwable e) {
                System.err.println("[spike] callback " + callback.getMethod() + " failed: " + e);
                e.printStackTrace();
            }
        }

        private void handle(ClientCallback callback) {
            switch (callback.getMethod()) {
                case GAME_INIT:
                    this.gameId = callback.getObjectId();
                    break;

                case START_GAME: {
                    TableClientMessage message = (TableClientMessage) callback.getData();
                    this.gameId = message.getGameId();
                    this.playerId = message.getPlayerId();
                    session.joinGame(gameId);
                    System.out.println("[spike] game started, joined as player " + playerId);
                    joinGameChat();
                    if (greedy) {
                        // force GAME_PLAY_MANA on every cast instead of silent auto-payment
                        session.sendPlayerAction(PlayerAction.MANA_AUTO_PAYMENT_OFF, gameId, null);
                        eventLog.logResponse("action", PlayerAction.MANA_AUTO_PAYMENT_OFF);
                    }
                    startWatchdog();
                    break;
                }

                case GAME_UPDATE:
                    this.gameView = (GameView) callback.getData();
                    break;

                case GAME_UPDATE_AND_INFORM:
                case GAME_INFORM_PERSONAL: {
                    GameClientMessage message = (GameClientMessage) callback.getData();
                    if (message.getGameView() != null) {
                        this.gameView = message.getGameView();
                    }
                    break;
                }

                case CHATMESSAGE: {
                    ChatMessage message = (ChatMessage) callback.getData();
                    System.out.println("[chat] " + message.getMessage());
                    break;
                }

                case GAME_ASK: {
                    GameClientMessage message = (GameClientMessage) callback.getData();
                    String text = message.getMessage() == null ? "" : message.getMessage();
                    int rounds = repeats("ask|" + text);
                    boolean yes;
                    if (text.contains("Mulligan")) {
                        yes = false;
                    } else if (text.contains("Pass anyway") || text.contains("mana pool")) {
                        // "You still have mana in your mana pool and it will be lost. Pass
                        // anyway?" — declining this forever was the phase-2 infinite loop
                        yes = true;
                    } else {
                        // default decline, but flip to yes if the same ask keeps coming
                        // back, so an unforeseen confirmation can't wedge the game
                        yes = rounds > 5;
                    }
                    respondBoolean("ask:" + text, yes);
                    break;
                }

                case GAME_SELECT: {
                    GameClientMessage message = (GameClientMessage) callback.getData();
                    if (message.getGameView() != null) {
                        this.gameView = message.getGameView();
                    }
                    resetActedOnNewTurn();
                    UUID objectId = null;
                    if (greedy && totalActions < MAX_ACTIONS
                            && repeats("select|" + message.getMessage()) <= MAX_PROMPT_REPEATS) {
                        objectId = pickAction(actedThisTurn);
                    }
                    if (objectId != null) {
                        totalActions++;
                        actedThisTurn.add(objectId);
                        session.sendPlayerUUID(gameId, objectId);
                        eventLog.logResponse("select:act", objectId);
                    } else {
                        respondBoolean("select:pass", false);
                    }
                    break;
                }

                case GAME_TARGET: {
                    GameClientMessage message = (GameClientMessage) callback.getData();
                    if (message.getGameView() != null) {
                        this.gameView = message.getGameView();
                    }
                    String text = message.getMessage() == null ? "" : message.getMessage();
                    int rounds = repeats("target|" + text);
                    UUID pick = rounds <= MAX_PROMPT_REPEATS ? pickTarget(message) : null;
                    if (pick != null) {
                        clickedThisPrompt.add(pick);
                        session.sendPlayerUUID(gameId, pick);
                        eventLog.logResponse("target:" + text, pick);
                    } else if (message.getMin() == 0) {
                        respondBoolean("target:cancel:" + text, false);
                    } else {
                        // required targets all chosen (or we gave up): done
                        respondBoolean("target:done:" + text, true);
                    }
                    break;
                }

                case GAME_CHOOSE_ABILITY: {
                    AbilityPickerView picker = (AbilityPickerView) callback.getData();
                    // alternate first/last so second-listed options (morph face-down,
                    // adventure halves, mode 2) get exercised across a game
                    UUID pick = null;
                    if (!picker.getChoices().isEmpty()) {
                        List<UUID> choiceIds = new ArrayList<UUID>(picker.getChoices().keySet());
                        abilityPickerToggle = !abilityPickerToggle;
                        pick = abilityPickerToggle
                                ? choiceIds.get(0)
                                : choiceIds.get(choiceIds.size() - 1);
                    }
                    if (pick != null) {
                        session.sendPlayerUUID(gameId, pick);
                        eventLog.logResponse("chooseAbility:" + picker.getMessage(), pick);
                    } else {
                        respondBoolean("chooseAbility:empty", false);
                    }
                    break;
                }

                case GAME_CHOOSE_CHOICE: {
                    GameClientMessage message = (GameClientMessage) callback.getData();
                    String answer = firstChoice(message.getChoice());
                    if (answer != null) {
                        session.sendPlayerString(gameId, answer);
                        eventLog.logResponse("choice", answer);
                    } else {
                        respondBoolean("choice-fallback", false);
                    }
                    break;
                }

                case GAME_CHOOSE_PILE: {
                    GameClientMessage message = (GameClientMessage) callback.getData();
                    // Swing convention: sendPlayerBoolean(true) = pile 1
                    respondBoolean("choosePile:" + message.getMessage(), true);
                    break;
                }

                case GAME_GET_AMOUNT: {
                    GameClientMessage message = (GameClientMessage) callback.getData();
                    // 2 beats min (usually 0) for coverage: X=2 forces a real mana payment
                    int amount = Math.max(message.getMin(), Math.min(message.getMax(), 2));
                    session.sendPlayerInteger(gameId, amount);
                    eventLog.logResponse("amount:" + message.getMessage()
                            + " [" + message.getMin() + ".." + message.getMax() + "]", amount);
                    break;
                }

                case GAME_GET_MULTI_AMOUNT: {
                    GameClientMessage message = (GameClientMessage) callback.getData();
                    // Swing convention: space-joined integers, one per row
                    String answer = buildMultiAmount(message);
                    session.sendPlayerString(gameId, answer);
                    eventLog.logResponse("multiAmount:" + message.getMessage(), answer);
                    break;
                }

                case GAME_PLAY_MANA:
                case GAME_PLAY_XMANA: {
                    GameClientMessage message = (GameClientMessage) callback.getData();
                    if (message.getGameView() != null) {
                        this.gameView = message.getGameView();
                    }
                    String text = message.getMessage() == null ? "" : message.getMessage();
                    int rounds = repeats("mana|" + text);
                    UUID source = rounds <= MAX_PROMPT_REPEATS ? pickPlayable(clickedThisPrompt) : null;
                    if (source != null) {
                        clickedThisPrompt.add(source);
                        session.sendPlayerUUID(gameId, source);
                        eventLog.logResponse("mana:tap:" + text, source);
                    } else {
                        ManaType pool = rounds <= MAX_PROMPT_REPEATS + 6 ? pickPoolMana() : null;
                        if (pool != null) {
                            session.sendPlayerManaType(gameId, playerId, pool);
                            eventLog.logResponse("mana:pool:" + text, pool);
                        } else {
                            respondBoolean("mana:cancel:" + text, false);
                        }
                    }
                    break;
                }

                case USER_REQUEST_DIALOG:
                    // rollback votes etc.; payload captured by the log, no answer needed
                    break;

                case GAME_OVER:
                    System.out.println("[spike] GAME_OVER received");
                    gameOver = true;
                    break;

                case END_GAME_INFO: {
                    GameEndView view = (GameEndView) callback.getData();
                    System.out.println("[spike] end game info, we " + (view.hasWon() ? "won" : "lost"));
                    gameOver = true;
                    break;
                }

                case JOINED_TABLE:
                case SHOW_USERMESSAGE:
                case SERVER_MESSAGE:
                    break;

                default:
                    // unknown interactive callback: nudge with a pass so the game
                    // doesn't hang, mirroring LoadCallbackClient's fallback
                    if (gameId != null && !gameOver) {
                        respondBoolean("unknown:" + callback.getMethod(), false);
                    }
                    break;
            }
        }

        private void joinGameChat() {
            try {
                Optional<UUID> chatId = session.getGameChatId(gameId);
                if (chatId.isPresent()) {
                    session.joinChat(chatId.get());
                    System.out.println("[spike] joined game chat " + chatId.get());
                } else {
                    System.out.println("[spike] game chat id not available");
                }
            } catch (Throwable e) {
                System.err.println("[spike] joinChat failed: " + e);
            }
        }

        private void resetActedOnNewTurn() {
            GameView view = gameView;
            if (view != null && view.getTurn() != lastSeenTurn) {
                lastSeenTurn = view.getTurn();
                actedThisTurn.clear();
            }
        }

        /**
         * Counts consecutive identical prompts so a non-converging dialog loop
         * (bad pick rejected and re-asked forever) gets abandoned instead of
         * spinning. Any new prompt key resets the per-prompt click memory.
         */
        private int repeats(String key) {
            if (!key.equals(lastPromptKey)) {
                lastPromptKey = key;
                promptRepeats = 0;
                clickedThisPrompt.clear();
            }
            return ++promptRepeats;
        }

        /**
         * What to do with priority. Hand cards and commanders first (casts and
         * land drops drive the game forward), then battlefield objects with a
         * non-mana activated ability. Never bare mana abilities: greedily
         * tapping lands for nothing floats mana, and passing with floating
         * mana triggers the "Pass anyway?" confirmation (phase-2 loop).
         */
        private UUID pickAction(Set<UUID> exclude) {
            GameView view = gameView;
            if (view == null || view.getCanPlayObjects() == null) {
                return null;
            }
            Map<UUID, PlayableObjectStats> objects = view.getCanPlayObjects().getObjects();
            List<UUID> ids = new ArrayList<UUID>(objects.keySet());
            Collections.sort(ids);
            Set<UUID> handOrCommand = myHandAndCommandIds(view);
            UUID fallback = null;
            for (UUID id : ids) {
                if (exclude.contains(id)) {
                    continue;
                }
                if (handOrCommand.contains(id)) {
                    return id;
                }
                PlayableObjectStats stats = objects.get(id);
                if (fallback == null && stats != null && stats.getPlayableImportantAmount() > 0) {
                    fallback = id;
                }
            }
            return fallback;
        }

        private Set<UUID> myHandAndCommandIds(GameView view) {
            Set<UUID> ids = new HashSet<UUID>();
            if (view.getMyHand() != null) {
                ids.addAll(view.getMyHand().keySet());
            }
            for (PlayerView p : view.getPlayers()) {
                if (playerId != null && playerId.equals(p.getPlayerId())) {
                    for (CommandObjectView c : p.getCommandObjectList()) {
                        ids.add(c.getId());
                    }
                }
            }
            return ids;
        }

        /** First playable object from the server's own legal-actions list, skipping excluded ids. */
        private UUID pickPlayable(Set<UUID> exclude) {
            GameView view = gameView;
            if (view == null || view.getCanPlayObjects() == null) {
                return null;
            }
            List<UUID> ids = new ArrayList<UUID>(view.getCanPlayObjects().getObjects().keySet());
            Collections.sort(ids);
            for (UUID id : ids) {
                if (!exclude.contains(id)) {
                    return id;
                }
            }
            return null;
        }

        /** First candidate target not already chosen (per server's chosenTargets) or clicked by us. */
        private UUID pickTarget(GameClientMessage message) {
            Set<UUID> taken = new HashSet<UUID>(clickedThisPrompt);
            try {
                if (message.getOptions() != null) {
                    Object chosen = message.getOptions().get("chosenTargets");
                    if (chosen instanceof Collection) {
                        for (Object o : (Collection<?>) chosen) {
                            if (o instanceof UUID) {
                                taken.add((UUID) o);
                            }
                        }
                    }
                }
            } catch (Throwable ignored) {
            }
            if (message.getTargets() != null) {
                for (UUID t : message.getTargets()) {
                    if (!taken.contains(t)) {
                        return t;
                    }
                }
            }
            if (message.getCardsView1() != null) {
                for (SimpleCardView c : message.getCardsView1().values()) {
                    if (!taken.contains(c.getId())) {
                        return c.getId();
                    }
                }
            }
            return null;
        }

        /** Spend floating mana from our pool, one type at a time. */
        private ManaType pickPoolMana() {
            GameView view = gameView;
            if (view == null || playerId == null) {
                return null;
            }
            for (PlayerView p : view.getPlayers()) {
                if (playerId.equals(p.getPlayerId())) {
                    ManaPoolView pool = p.getManaPool();
                    if (pool == null) {
                        return null;
                    }
                    if (pool.getWhite() > 0) return ManaType.WHITE;
                    if (pool.getBlue() > 0) return ManaType.BLUE;
                    if (pool.getBlack() > 0) return ManaType.BLACK;
                    if (pool.getRed() > 0) return ManaType.RED;
                    if (pool.getGreen() > 0) return ManaType.GREEN;
                    if (pool.getColorless() > 0) return ManaType.COLORLESS;
                    return null;
                }
            }
            return null;
        }

        /** Row mins first, then pile the remaining total onto the earliest rows with room. */
        private static String buildMultiAmount(GameClientMessage message) {
            List<MultiAmountMessage> rows = message.getMessages();
            if (rows == null || rows.isEmpty()) {
                return "";
            }
            int n = rows.size();
            int[] vals = new int[n];
            int sum = 0;
            for (int i = 0; i < n; i++) {
                vals[i] = Math.max(0, rows.get(i).min);
                sum += vals[i];
            }
            int target = Math.max(message.getMin(), message.getMax());
            for (int i = 0; i < n && sum < target; i++) {
                int add = Math.min(rows.get(i).max - vals[i], target - sum);
                if (add > 0) {
                    vals[i] += add;
                    sum += add;
                }
            }
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < n; i++) {
                if (i > 0) {
                    sb.append(' ');
                }
                sb.append(vals[i]);
            }
            return sb.toString();
        }

        private String firstChoice(Choice choice) {
            try {
                if (choice == null) {
                    return null;
                }
                if (choice.isKeyChoice() && !choice.getKeyChoices().isEmpty()) {
                    return choice.getKeyChoices().keySet().iterator().next();
                }
                if (!choice.getChoices().isEmpty()) {
                    return choice.getChoices().iterator().next();
                }
            } catch (Throwable e) {
                System.err.println("[spike] choice inspection failed: " + e);
            }
            return null;
        }

        private void respondBoolean(String kind, boolean answer) {
            if (gameId == null) {
                return;
            }
            session.sendPlayerBoolean(gameId, answer);
            eventLog.logResponse(kind, answer);
        }

        /** If no callback arrives for a while mid-game, nudge the server (frozen-game guard from LoadCallbackClient). */
        private void startWatchdog() {
            if (watchdogStarted) {
                return;
            }
            watchdogStarted = true;
            Thread t = new Thread(new Runnable() {
                @Override
                public void run() {
                    while (!gameOver) {
                        try {
                            Thread.sleep(1000);
                        } catch (InterruptedException e) {
                            return;
                        }
                        quietSeconds++;
                        if (quietSeconds > 8) {
                            System.out.println("[spike] no callbacks for 8s, nudging server with a pass");
                            quietSeconds = 0;
                            session.sendPlayerBoolean(gameId, false);
                        }
                    }
                }
            }, "spike-watchdog");
            t.setDaemon(true);
            t.start();
        }
    }
}
