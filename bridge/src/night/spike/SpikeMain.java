package night.spike;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import mage.cards.decks.DeckCardInfo;
import mage.cards.decks.DeckCardLists;
import mage.choices.Choice;
import mage.constants.MultiplayerAttackOption;
import mage.constants.RangeOfInfluence;
import mage.game.match.MatchOptions;
import mage.interfaces.MageClient;
import mage.interfaces.callback.ClientCallback;
import mage.players.PlayerType;
import mage.remote.Connection;
import mage.remote.Session;
import mage.remote.SessionImpl;
import mage.utils.MageVersion;
import mage.view.ChatMessage;
import mage.view.GameClientMessage;
import mage.view.GameEndView;
import mage.view.GameView;
import mage.view.SimpleCardView;
import mage.view.TableClientMessage;
import mage.view.TableView;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Commander Night bridge spike.
 *
 * Connects to a local XMage server as a headless client, creates a Commander
 * Free For All table, seats itself (auto-passing every priority) plus three AI
 * players, starts the match, and streams every server callback to a JSON-lines
 * log. Success = a full game captured in the log.
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
        String distDecks = "vendor/xmage-dist/xmage/mage-client/sample-decks/Commander/";
        String[] deckFiles = {
                distDecks + "Zurgo Helmsmasher RWB.dck",   // bridge (never acts, just passes)
                distDecks + "Tasigur BGU.dck",             // ai_1
                distDecks + "Geoff's Daxos of Meletis.dck",// ai_2
                distDecks + "Zurgo Helmsmasher RWB.dck",   // ai_3 (duplicate is fine)
        };

        File logDir = new File("bridge/logs");
        logDir.mkdirs();
        File logFile = new File(logDir, "spike-" + System.currentTimeMillis() + ".jsonl");
        JsonEventLog eventLog = new JsonEventLog(logFile);
        System.out.println("[spike] logging to " + logFile.getPath());

        DeckCardLists[] decks = new DeckCardLists[4];
        for (int i = 0; i < 4; i++) {
            decks[i] = parseDck(deckFiles[i]);
            System.out.println("[spike] deck " + i + ": " + deckFiles[i]
                    + " main=" + decks[i].getCards().size()
                    + " sb=" + decks[i].getSideboard().size());
        }

        BridgeClient client = new BridgeClient(eventLog);
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
            System.err.println("[spike] FAILED to seat bridge player");
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
                + ", turns seen: " + client.getLastTurn());
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
     * Headless MageClient: logs every callback, answers the minimum set of
     * prompts to keep a game moving (never mulligans, always passes priority).
     */
    static final class BridgeClient implements MageClient {
        private final MageVersion version = new MageVersion(MageClient.class);
        private final JsonEventLog eventLog;
        private volatile Session session;
        private volatile UUID gameId;
        private volatile UUID playerId;
        private volatile GameView gameView;
        private volatile boolean gameOver;
        private volatile int quietSeconds;
        private volatile boolean watchdogStarted;

        BridgeClient(JsonEventLog eventLog) {
            this.eventLog = eventLog;
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
                    // "Mulligan ..." and anything else: decline
                    respondBoolean("ask:" + message.getMessage(), false);
                    break;
                }

                case GAME_SELECT: {
                    GameClientMessage message = (GameClientMessage) callback.getData();
                    if (message.getGameView() != null) {
                        this.gameView = message.getGameView();
                    }
                    // pass priority
                    respondBoolean("select", false);
                    break;
                }

                case GAME_TARGET: {
                    GameClientMessage message = (GameClientMessage) callback.getData();
                    if (message.getGameView() != null) {
                        this.gameView = message.getGameView();
                    }
                    String text = message.getMessage() == null ? "" : message.getMessage();
                    if (text.startsWith("Select a starting player")) {
                        session.sendPlayerUUID(gameId, playerId);
                        eventLog.logResponse("target:" + text, playerId);
                    } else if (text.contains("discard") && gameView != null
                            && gameView.getMyHand() != null && !gameView.getMyHand().isEmpty()) {
                        SimpleCardView card = gameView.getMyHand().values().iterator().next();
                        session.sendPlayerUUID(gameId, card.getId());
                        eventLog.logResponse("target:" + text, card.getId());
                    } else {
                        // cancel / decline optional target
                        respondBoolean("target:" + text, false);
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

                case GAME_GET_AMOUNT: {
                    GameClientMessage message = (GameClientMessage) callback.getData();
                    session.sendPlayerInteger(gameId, message.getMin());
                    eventLog.logResponse("amount", message.getMin());
                    break;
                }

                case GAME_PLAY_MANA:
                case GAME_PLAY_XMANA:
                    // we never cast anything; cancel
                    respondBoolean("mana-cancel", false);
                    break;

                case GAME_OVER:
                    System.out.println("[spike] GAME_OVER received");
                    gameOver = true;
                    break;

                case END_GAME_INFO: {
                    GameEndView view = (GameEndView) callback.getData();
                    System.out.println("[spike] end game info, we " + (view.hasWon() ? "won (?!)" : "lost (expected)"));
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
