package night.bridge.game;

import mage.interfaces.callback.ClientCallback;
import mage.view.AbilityPickerView;
import mage.view.ChatMessage;
import mage.view.GameClientMessage;
import mage.view.GameEndView;
import mage.view.GameView;
import mage.view.TableClientMessage;
import night.bridge.net.ClientSink;
import night.bridge.proto.Err;
import night.bridge.proto.ErrorCode;
import night.bridge.proto.GameAnswer;
import night.bridge.proto.GameOver;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.LogEntry;
import night.bridge.proto.PromptDone;
import night.bridge.proto.ServerMsg;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.Player;
import night.bridge.sync.StateStore;
import night.bridge.translate.LogTranslator;
import night.bridge.translate.PromptTranslator;
import night.bridge.translate.ViewTranslator;
import night.bridge.xmage.SeatSession;
import night.bridge.xmage.XmageAnswers;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/**
 * One human seat's single-thread executor and ownership boundary (design §4):
 * the canonical GameState, seq counter, prompt FSM, and log ring live here
 * and are touched by nothing else. XMage callbacks and client answers are
 * enqueued from other threads; everything runs in order on the pump.
 *
 * <p>Emit order per design §7: state first (keyframe), then the prompt that
 * referenced it. M2 is keyframes-only; patches arrive with M3.
 */
public final class SeatPump implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(SeatPump.class);

    private final ExecutorService exec;
    private final SeatSession xmage;
    private final ClientSink sink;
    private final GameCoordinator coordinator;
    private final StateStore store = new StateStore();
    private final Deque<LogEntry> logRing = new ArrayDeque<>();
    private final int logRingCapacity;

    // Pump-thread state — no other thread reads or writes these.
    private UUID gameId;
    private UUID playerId;
    private String gameIdStr;
    private PromptFsm fsm;
    private GameState lastState;
    private boolean over;

    public SeatPump(String seatLabel, SeatSession xmage, ClientSink sink,
                    GameCoordinator coordinator, int logRingCapacity) {
        this.exec = Executors.newSingleThreadExecutor(
                Thread.ofVirtual().name("seat-" + seatLabel).factory());
        this.xmage = xmage;
        this.sink = sink;
        this.coordinator = coordinator;
        this.logRingCapacity = logRingCapacity;
    }

    /** XMage-thread entry: decompressed callbacks, in arrival order. */
    public void onCallback(ClientCallback callback) {
        exec.execute(() -> {
            MDC.put("seat", xmage.username());
            MDC.put("game", gameIdStr == null ? "-" : gameIdStr);
            try {
                handle(callback);
            } catch (Throwable t) {
                log.error("callback {} failed on the pump", callback.getMethod(), t);
            } finally {
                MDC.clear();
            }
        });
    }

    /** Jetty-thread entry: an answer command from this seat's browser. */
    public void answer(GameAnswer cmd, Consumer<ServerMsg> reply) {
        exec.execute(() -> {
            if (fsm == null) {
                reply.accept(Err.re(cmd.id(), ErrorCode.PROMPT_STALE, "the game has not started"));
                return;
            }
            switch (fsm.answer(cmd.promptId(), cmd.answer())) {
                case PromptFsm.Outcome.Rejected(ErrorCode code, String message) ->
                        reply.accept(Err.re(cmd.id(), code, message));
                case PromptFsm.Outcome.Applied() -> {
                    reply.accept(new night.bridge.proto.Ack(cmd.id()));
                    sink.send(new PromptDone(store.nextSeq(), gameIdStr, cmd.promptId(),
                            PromptDone.Reason.ANSWERED));
                }
            }
        });
    }

    private void handle(ClientCallback cb) {
        switch (cb.getMethod()) {
            case START_GAME -> startGame((TableClientMessage) cb.getData());
            case GAME_INIT -> {
                if (gameIdStr == null) {
                    gameId = cb.getObjectId();
                    gameIdStr = gameId.toString();
                }
                // GAME_INIT's payload is the first GameView of the game.
                if (cb.getData() instanceof GameView view) {
                    updateState(view);
                }
            }
            case GAME_UPDATE -> updateState((GameView) cb.getData());
            case GAME_UPDATE_AND_INFORM -> {
                // The inform text is dropped (protocol §15); the log rides CHATMESSAGE.
                GameClientMessage msg = (GameClientMessage) cb.getData();
                updateState(msg.getGameView());
            }
            case GAME_INFORM_PERSONAL -> {
                GameClientMessage msg = (GameClientMessage) cb.getData();
                updateState(msg.getGameView());
                logLine(LogEntry.Kind.PERSONAL, null, night.bridge.translate.Html.strip(msg.getMessage()), null, null);
            }
            case CHATMESSAGE -> chat((ChatMessage) cb.getData());

            case GAME_ASK -> {
                GameClientMessage msg = (GameClientMessage) cb.getData();
                updateState(msg.getGameView());
                present(PromptTranslator.confirm(fsm.nextPromptId(), msg));
            }
            case GAME_SELECT -> {
                GameClientMessage msg = (GameClientMessage) cb.getData();
                updateState(msg.getGameView());
                present(PromptTranslator.priority(fsm.nextPromptId(), msg, msg.getGameView()));
            }
            case GAME_TARGET -> {
                GameClientMessage msg = (GameClientMessage) cb.getData();
                updateState(msg.getGameView());
                present(PromptTranslator.chooseTargets(fsm.nextPromptId(), msg));
            }
            case GAME_PLAY_MANA -> {
                GameClientMessage msg = (GameClientMessage) cb.getData();
                updateState(msg.getGameView());
                present(PromptTranslator.payMana(fsm.nextPromptId(), msg, msg.getGameView()));
            }

            case GAME_ERROR -> {
                String text = String.valueOf(cb.getData());
                sink.send(Err.of(ErrorCode.UPSTREAM_ERROR, text));
                logLine(LogEntry.Kind.ERROR, null, text, null, null);
            }
            case GAME_OVER -> {
                GameClientMessage msg = (GameClientMessage) cb.getData();
                updateState(msg.getGameView());
                coordinator.recordGameOver(msg.getMessage());
                finish();
            }
            case END_GAME_INFO -> {
                if (cb.getData() instanceof GameEndView end) {
                    coordinator.recordEndInfo(end.getGameInfo());
                }
                finish();
            }

            // Dialogs outside the M2 vocabulary: design §8 — never auto-answer;
            // a visible stall beats a silently wrong positional answer.
            case GAME_CHOOSE_ABILITY -> {
                if (cb.getData() instanceof AbilityPickerView picker) {
                    updateState(picker.getGameView());
                }
                unmapped(cb);
            }
            case GAME_CHOOSE_CHOICE, GAME_CHOOSE_PILE, GAME_GET_AMOUNT, GAME_GET_MULTI_AMOUNT,
                 GAME_PLAY_XMANA -> {
                if (cb.getData() instanceof GameClientMessage msg) {
                    updateState(msg.getGameView());
                }
                unmapped(cb);
            }
            case USER_REQUEST_DIALOG -> unmapped(cb);

            case JOINED_TABLE, GAME_REDRAW_GUI, SHOW_USERMESSAGE, SERVER_MESSAGE -> {
                // table plumbing / GUI hints — nothing to relay in M2
            }
            default -> log.debug("ignoring callback {}", cb.getMethod());
        }
    }

    private void startGame(TableClientMessage msg) {
        gameId = msg.getGameId();
        playerId = msg.getPlayerId();
        gameIdStr = gameId.toString();
        fsm = new PromptFsm(new XmageAnswers(xmage.session(), gameId, playerId));
        xmage.session().joinGame(gameId);
        xmage.session().getGameChatId(gameId).ifPresent(chatId -> xmage.session().joinChat(chatId));
        coordinator.gameKnown(gameId);
        log.info("joined game {} as player {}", gameId, playerId);
    }

    private void updateState(GameView view) {
        if (view == null || gameIdStr == null) {
            return;
        }
        lastState = ViewTranslator.translate(view, gameIdStr, playerId);
        store.keyframe(gameIdStr, lastState).ifPresent(sink::send);
    }

    private void present(GamePrompt prompt) {
        if (over) {
            return;
        }
        GamePrompt superseded = fsm.pending();
        if (superseded != null) {
            sink.send(new PromptDone(store.nextSeq(), gameIdStr, superseded.promptId(),
                    PromptDone.Reason.SUPERSEDED));
        }
        GamePrompt emitted = prompt.emitted(store.nextSeq(), gameIdStr);
        fsm.present(emitted);
        sink.send(emitted);
    }

    private void chat(ChatMessage msg) {
        LogTranslator.chat(msg).ifPresent(line ->
                logLine(line.kind(), line.turn(), line.text(), line.refs(), resolvePlayer(line.username())));
    }

    private void logLine(LogEntry.Kind kind, String turn, String text,
                         List<LogEntry.Ref> refs, String playerId) {
        LogEntry entry = new LogEntry(store.nextSeq(), gameIdStr, System.currentTimeMillis(),
                kind, turn, text, refs, playerId);
        logRing.addLast(entry);
        if (logRing.size() > logRingCapacity) {
            logRing.removeFirst();
        }
        sink.send(entry);
    }

    private String resolvePlayer(String username) {
        if (username == null || lastState == null) {
            return null;
        }
        for (Player p : lastState.players()) {
            if (p.name().equals(username)) {
                return p.id();
            }
        }
        return null;
    }

    private void unmapped(ClientCallback cb) {
        log.warn("unmapped interactive callback {} — surfacing the stall (design §8)", cb.getMethod());
        sink.send(Err.of(ErrorCode.UPSTREAM_ERROR,
                "the game asked a question this bridge cannot relay yet (" + cb.getMethod() + ")"));
        logLine(LogEntry.Kind.ERROR, null,
                "Unsupported game dialog (" + cb.getMethod() + ") — the seat is stalled on it.", null, null);
    }

    private void finish() {
        if (over || gameIdStr == null) {
            return;
        }
        over = true;
        GameCoordinator.Outcome outcome = coordinator.outcome();
        if (lastState != null) {
            lastState = lastState.over();
            store.keyframe(gameIdStr, lastState).ifPresent(sink::send);
        }
        if (fsm != null && fsm.pending() != null) {
            sink.send(new PromptDone(store.nextSeq(), gameIdStr, fsm.pending().promptId(),
                    PromptDone.Reason.GAME_OVER));
            fsm.clear();
        }
        sink.send(new GameOver(store.nextSeq(), gameIdStr, winners(outcome), outcome.reason(), true));
        log.info("game over for this seat: {}", outcome.reason());
    }

    private List<String> winners(GameCoordinator.Outcome outcome) {
        List<String> ids = new ArrayList<>();
        if (outcome.winnerName() != null && lastState != null) {
            for (Player p : lastState.players()) {
                if (p.name().equals(outcome.winnerName())) {
                    ids.add(p.id());
                }
            }
        }
        return ids;
    }

    @Override
    public void close() {
        exec.close();
    }
}
