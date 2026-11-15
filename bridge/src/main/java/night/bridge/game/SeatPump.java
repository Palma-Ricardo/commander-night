package night.bridge.game;

import mage.constants.PlayerAction;
import mage.interfaces.callback.ClientCallback;
import night.bridge.proto.ChatSend;
import mage.view.AbilityPickerView;
import mage.view.ChatMessage;
import mage.view.GameClientMessage;
import mage.view.GameEndView;
import mage.view.GameView;
import mage.view.TableClientMessage;
import mage.view.UserRequestMessage;
import night.bridge.net.ClientSink;
import night.bridge.proto.Ack;
import night.bridge.proto.Answer;
import night.bridge.proto.Err;
import night.bridge.proto.ErrorCode;
import night.bridge.proto.GameAction;
import night.bridge.proto.GameAnswer;
import night.bridge.proto.GameOver;
import night.bridge.proto.GamePrompt;
import night.bridge.proto.GameResync;
import night.bridge.proto.LogEntry;
import night.bridge.proto.PromptDone;
import night.bridge.proto.ServerMsg;
import night.bridge.proto.event.GameEvent;
import night.bridge.proto.state.GameState;
import night.bridge.proto.state.Player;
import night.bridge.sync.StateStore;
import night.bridge.translate.EventDeriver;
import night.bridge.translate.Html;
import night.bridge.translate.LogTranslator;
import night.bridge.translate.PromptNames;
import night.bridge.translate.PromptTranslator;
import night.bridge.translate.RevealLatch;
import night.bridge.translate.ViewTranslator;
import night.bridge.xmage.SeatSession;
import night.bridge.xmage.TableRecipe;
import night.bridge.xmage.XmageAnswers;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/**
 * One human seat's single-thread executor and ownership boundary (design §4):
 * the canonical GameState, seq counter, prompt FSM, and log ring live here
 * and are touched by nothing else. XMage callbacks and client commands are
 * enqueued from other threads; everything runs in order on the pump.
 *
 * <p>Emit order per design §7: state first (patch or keyframe), then the
 * prompt that referenced it. Positional dialogs pass through the FSM's
 * replay interception ({@link PromptFsm#onDialog}) before presentation;
 * out-of-band USER_REQUEST_DIALOGs are deferred while a replay is in flight.
 */
public final class SeatPump implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(SeatPump.class);

    /** Seat recovery (design §5): reconnect attempts after XMage transport loss. */
    private static final long[] RECOVER_BACKOFF_MILLIS = {2_000, 4_000, 8_000, 15_000, 15_000};

    private final ExecutorService exec;
    private final SeatSession xmage;
    private final ClientSink sink;
    private final GameCoordinator coordinator;
    private final StateStore store;
    private final BooleanSupplier keyframesOnly;
    private final Deque<LogEntry> logRing = new ArrayDeque<>();
    private final int logRingCapacity;
    private final int backfillSend;

    /**
     * Answers this seat's prompts in-JVM for a bridge-hosted AI seat; {@link
     * SeatDriver#NONE} for a browser seat (the browser answers over the wire).
     * Set from the lobby thread before the game starts, read on the pump thread
     * in {@link #present} — volatile for safe publication across that boundary.
     */
    private volatile SeatDriver driver = SeatDriver.NONE;

    /** When the seat last heard from XMage — written on callback threads, read by answer pacing. */
    private volatile long lastCallbackNanos = System.nanoTime();

    // Pump-thread state — no other thread reads or writes these.
    private UUID gameId;
    private UUID playerId;
    private String gameIdStr;
    private UUID chatId;
    private XmageAnswers answers;
    private PromptFsm fsm;
    private GameState lastState;
    private final RevealLatch revealLatch = new RevealLatch();
    private final List<PendingLogLine> preGameLog = new ArrayList<>();
    /**
     * Log lines seen since the last state emit, buffered for the M6 event join
     * (design §5): the log arrives one callback ahead of the state it describes,
     * so {@link #updateState} drains this into {@link EventDeriver}. Kept (not
     * cleared) across an empty-delta snapshot, so a cast line still meets the
     * update that actually puts the spell on the stack.
     */
    private final List<LogEntry> pendingLog = new ArrayList<>();
    private GamePrompt deferredRequest;
    private UUID deferredRequestData;
    private boolean over;
    /** The emitted game.over, kept for post-game resume replay (protocol §14). */
    private GameOver gameOverMsg;
    /** Seat recovery in flight (design §5) — positional answers are rejected meanwhile. */
    private boolean recovering;
    /** Drops updates the 1.4.63 callback queue delivered behind newer state (protocol §15). */
    private final UpdateOrder order = new UpdateOrder();
    /** Positional asks seen, for the debug log. */
    private long askCount;
    /** Early mulligan asks (protocol §8): when this seat's hand is ready before XMage asks it. */
    private final MulliganWindow mulligan = new MulliganWindow(TableRecipe.FREE_MULLIGANS);

    public SeatPump(String seatLabel, SeatSession xmage, ClientSink sink,
                    GameCoordinator coordinator, int logRingCapacity, int backfillSend,
                    int keyframeEvery, BooleanSupplier keyframesOnly) {
        this.exec = Executors.newSingleThreadExecutor(
                Thread.ofVirtual().name("seat-" + seatLabel).factory());
        this.xmage = xmage;
        this.sink = sink;
        this.coordinator = coordinator;
        this.logRingCapacity = logRingCapacity;
        this.backfillSend = backfillSend;
        this.store = new StateStore(keyframeEvery);
        this.keyframesOnly = keyframesOnly;
    }

    /** Attach a bridge-hosted AI driver; browser seats keep {@link SeatDriver#NONE}. */
    public void driver(SeatDriver driver) {
        this.driver = driver;
    }

    /**
     * Off-pump entry for a bridge-hosted AI seat's brain: submit an answer to the
     * pending prompt through the identical path a browser answer takes ({@link
     * #answer}). Enqueues onto the pump executor, so it is safe to call from the
     * driver's decision thread. A stale promptId is rejected as {@code
     * PROMPT_STALE}, exactly as a late browser answer would be.
     */
    public void submitAnswer(long promptId, Answer answer) {
        if (gameIdStr == null) {
            return;
        }
        answer(new GameAnswer("ai-" + gameIdStr + "-" + promptId, gameIdStr, promptId, answer),
                msg -> {
                    if (msg instanceof Err) {
                        log.debug("ai seat answer to prompt {} rejected: {}", promptId, msg);
                    }
                });
    }

    /** Enqueue a command handler; a torn-down pump answers UNKNOWN_GAME (§14 teardown). */
    private void enqueueCmd(String cmdId, Consumer<ServerMsg> reply, Runnable task) {
        try {
            exec.execute(task);
        } catch (RejectedExecutionException e) {
            reply.accept(Err.re(cmdId, ErrorCode.UNKNOWN_GAME, "the game is gone"));
        }
    }

    /** XMage-thread entry: decompressed callbacks, in arrival order. */
    public void onCallback(ClientCallback callback) {
        lastCallbackNanos = System.nanoTime();
        Runnable task = () -> {
            MDC.put("seat", xmage.username());
            MDC.put("game", gameIdStr == null ? "-" : gameIdStr);
            try {
                log.debug("callback {}", callback.getMethod());
                handle(callback);
            } catch (Throwable t) {
                log.error("callback {} failed on the pump", callback.getMethod(), t);
            } finally {
                MDC.clear();
            }
        };
        try {
            exec.execute(task);
        } catch (RejectedExecutionException e) {
            log.debug("callback {} after teardown — dropped", callback.getMethod());
        }
    }

    /** Jetty-thread entry: an answer command from this seat's browser. */
    public void answer(GameAnswer cmd, Consumer<ServerMsg> reply) {
        enqueueCmd(cmd.id(), reply, () -> {
            if (fsm == null) {
                reply.accept(Err.re(cmd.id(), ErrorCode.PROMPT_STALE, "the game has not started"));
                return;
            }
            if (recovering) {
                reply.accept(Err.re(cmd.id(), ErrorCode.UPSTREAM_ERROR,
                        "reconnecting to the game server — try again in a moment"));
                return;
            }
            GamePrompt answering = fsm.pending();
            boolean liveMulligan = answering != null && !fsm.preAskPending()
                    && mulligan.open() && MulliganWindow.isMulliganAsk(answering);
            PromptFsm.Outcome outcome = fsm.answer(cmd.promptId(), cmd.answer());
            log.debug("answer promptId={} -> {}", cmd.promptId(), outcome);
            switch (outcome) {
                case PromptFsm.Outcome.Rejected(ErrorCode code, String message) ->
                        reply.accept(Err.re(cmd.id(), code, message));
                case PromptFsm.Outcome.Applied(GamePrompt revived) -> {
                    reply.accept(new Ack(cmd.id()));
                    promptDone(cmd.promptId(), PromptDone.Reason.ANSWERED);
                    if (liveMulligan && cmd.answer() instanceof Answer.Confirm(boolean value)) {
                        mulligan.decided(value);
                    }
                    if (revived != null) {
                        present(revived);   // back to waiting on the client
                    }
                }
                // early mulligan answer: held until XMage asks (§8), so nothing to watch yet
                case PromptFsm.Outcome.Held(boolean value) -> {
                    reply.accept(new Ack(cmd.id()));
                    promptDone(cmd.promptId(), PromptDone.Reason.ANSWERED);
                    log.debug("early mulligan answer held: {}", value ? "mulligan" : "keep");
                }
                // whole-set replay in flight — promptDone follows its resolution (§8)
                case PromptFsm.Outcome.ReplayStarted() -> reply.accept(new Ack(cmd.id()));
            }
        });
    }

    /** Jetty-thread entry: a prompt-free player action (protocol §9). */
    public void action(GameAction cmd, Consumer<ServerMsg> reply) {
        enqueueCmd(cmd.id(), reply, () -> {
            if (answers == null || over) {
                reply.accept(Err.re(cmd.id(), ErrorCode.UNKNOWN_GAME,
                        over ? "the game is over" : "the game has not started"));
                return;
            }
            if (recovering) {
                reply.accept(Err.re(cmd.id(), ErrorCode.UPSTREAM_ERROR,
                        "reconnecting to the game server — try again in a moment"));
                return;
            }
            switch (cmd.action()) {
                case GameAction.Action.Concede() -> answers.action(PlayerAction.CONCEDE);
                case GameAction.Action.Skip(GameAction.Action.Skip.Mode mode) ->
                        answers.action(skipAction(mode));
                case GameAction.Action.RequestRollback(int turns) -> {
                    if (turns < 0) {
                        reply.accept(Err.re(cmd.id(), ErrorCode.BAD_MESSAGE, "turns must be >= 0"));
                        return;
                    }
                    answers.action(PlayerAction.ROLLBACK_TURNS, turns);
                }
                case GameAction.Action.AutoMana(boolean enabled) -> answers.action(
                        enabled ? PlayerAction.MANA_AUTO_PAYMENT_ON : PlayerAction.MANA_AUTO_PAYMENT_OFF);
                case GameAction.Action.TriggerOrder(GameAction.Action.TriggerOrder.Mode mode) ->
                        answers.action(PlayerAction.TRIGGER_AUTO_ORDER_RESET_ALL);
            }
            reply.accept(new Ack(cmd.id()));
        });
    }

    /** Jetty-thread entry: the client wants a fresh keyframe (protocol §7). */
    public void resync(GameResync cmd, Consumer<ServerMsg> reply) {
        enqueueCmd(cmd.id(), reply, () -> {
            reply.accept(new Ack(cmd.id()));
            if (gameIdStr != null) {
                store.forceKeyframe(gameIdStr).ifPresent(sink::send);
            }
        });
    }

    /** Jetty-thread entry: relay chat into the game (protocol §10). */
    public void chatSend(ChatSend cmd, Consumer<ServerMsg> reply) {
        enqueueCmd(cmd.id(), reply, () -> {
            String text = cmd.text() == null ? "" : cmd.text().strip();
            if (text.isEmpty() || text.length() > ChatSend.MAX_LENGTH) {
                reply.accept(Err.re(cmd.id(), ErrorCode.BAD_MESSAGE, text.isEmpty()
                        ? "chat text is empty"
                        : "chat text exceeds " + ChatSend.MAX_LENGTH + " chars"));
                return;
            }
            if (chatId == null) {
                reply.accept(Err.re(cmd.id(), ErrorCode.UNKNOWN_GAME, "the game chat is not open yet"));
                return;
            }
            if (xmage.session().sendChatMessage(chatId, text)) {
                // the line comes back to every seat as CHATMESSAGE → game.log kind:chat
                reply.accept(new Ack(cmd.id()));
            } else {
                reply.accept(Err.re(cmd.id(), ErrorCode.UPSTREAM_ERROR,
                        "the game server rejected the chat message"));
            }
        });
    }

    /**
     * Session-layer entry: the XMage transport dropped (design §5). Best-effort
     * recovery — the browser is told via status log lines, positional answers
     * are rejected while it runs, and the seat re-joins on success.
     */
    public void onXmageDisconnected() {
        try {
            exec.execute(this::startRecovery);
        } catch (RejectedExecutionException e) {
            // torn down — nothing to recover
        }
    }

    private void startRecovery() {
        if (over || recovering || gameId == null) {
            // pre-game drops are the lobby's problem (table setup fails loudly)
            return;
        }
        recovering = true;
        order.reset(); // the old session is gone; a new one numbers callbacks from 1
        logLine(LogEntry.Kind.STATUS, null, "reconnecting to the game server…", null, null);
        Thread.ofVirtual().name("recover-" + xmage.username()).start(this::recoveryLoop);
    }

    /** Off-pump: blocking reconnect attempts with backoff; result hops back onto the pump. */
    private void recoveryLoop() {
        for (long backoff : RECOVER_BACKOFF_MILLIS) {
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            if (xmage.reconnect()) {
                try {
                    exec.execute(this::recovered);
                } catch (RejectedExecutionException ignored) {
                    // torn down while we were reconnecting
                }
                return;
            }
        }
        try {
            exec.execute(() -> {
                recovering = false;
                log.error("seat recovery failed after {} attempts — seat lost", RECOVER_BACKOFF_MILLIS.length);
                logLine(LogEntry.Kind.STATUS, null,
                        "could not reconnect to the game server — this seat is lost", null, null);
                sink.send(Err.fatal(null, ErrorCode.UPSTREAM_ERROR,
                        "lost the connection to the game server; this seat cannot continue"));
                // a lost seat never sees GAME_OVER — count it toward teardown
                // or the game (and its XMage sessions) would leak forever
                coordinator.seatFinished();
            });
        } catch (RejectedExecutionException ignored) {
        }
    }

    private void recovered() {
        recovering = false;
        if (over) {
            return;
        }
        joinGameAndChat();
        logLine(LogEntry.Kind.STATUS, null, "reconnected to the game server", null, null);
        regroundBrowser();
        // XMage does NOT re-fire an in-flight ask on rejoin (GameController.join only
        // re-registers the session), and an ask that fired into the dying socket may
        // never have reached this seat (live-observed 2026-07-18: ~50 s with no prompt).
        // One nudge makes a game thread waiting on this seat re-fire its ask on the new
        // session. It can't be conditioned on a pending prompt: the lost ask is exactly
        // the case where none is pending. Residual risk: if XMage is waiting on another
        // seat, the nudge parks (≤30 s) and lands on this seat's next ask, which XMage
        // re-fires. An AI seat that answers both the ask and its re-fire is then one
        // answer ahead (the K32ZYQ failure). That takes a reconnect plus a sub-60 ms
        // answer, and only the in-JVM brain answers that fast.
        if (answers != null) {
            answers.nudge();
        }
    }

    /** Join the game + its chat on the current XMage session (start and recovery). */
    private void joinGameAndChat() {
        xmage.session().joinGame(gameId);
        xmage.session().getGameChatId(gameId).ifPresent(id -> {
            chatId = id;
            xmage.session().joinChat(id);
        });
    }

    /**
     * The §14/§5 re-ground: fresh keyframe first, then the pending prompt under
     * its original promptId with a fresh seq — answers stay fenced across the
     * gap. A compound replay in flight re-emits nothing: the client already
     * answered, and promptDone lands when the replay resolves.
     */
    private void regroundBrowser() {
        store.forceKeyframe(gameIdStr).ifPresent(sink::send);
        if (fsm != null && fsm.pending() != null && !fsm.replaying()) {
            sink.send(fsm.pending().withSeq(store.nextSeq()));
        }
    }

    /**
     * Registry-thread entry: replay this seat for a (re)connected browser
     * (protocol §14) — fresh keyframe, pending prompt under its original
     * promptId, then the log tail. False if the pump is already torn down.
     */
    public boolean resume(long lastSeq) {
        try {
            exec.execute(() -> replayForResume(lastSeq));
            return true;
        } catch (RejectedExecutionException e) {
            return false;
        }
    }

    private void replayForResume(long lastSeq) {
        if (gameIdStr == null) {
            return; // resume raced startMatch — the first callbacks will paint state
        }
        if (over) {
            store.forceKeyframe(gameIdStr).ifPresent(sink::send);
            if (gameOverMsg != null) {
                sink.send(gameOverMsg); // original seq — history, like the backfill below
            }
        } else {
            regroundBrowser();
        }
        List<LogEntry> tail = new ArrayList<>();
        for (LogEntry e : logRing) {
            if (e.seq() > lastSeq) {
                tail.add(e);
            }
        }
        if (tail.size() > backfillSend) {
            tail = tail.subList(tail.size() - backfillSend, tail.size());
        }
        tail.forEach(sink::send);
    }

    private static PlayerAction skipAction(GameAction.Action.Skip.Mode mode) {
        return switch (mode) {
            case STACK -> PlayerAction.PASS_PRIORITY_UNTIL_STACK_RESOLVED;
            case END_OF_TURN -> PlayerAction.PASS_PRIORITY_UNTIL_TURN_END_STEP;
            case NEXT_MAIN -> PlayerAction.PASS_PRIORITY_UNTIL_NEXT_MAIN_PHASE;
            case MY_NEXT_TURN -> PlayerAction.PASS_PRIORITY_UNTIL_MY_NEXT_TURN;
            case END_STEP_BEFORE_MY_TURN -> PlayerAction.PASS_PRIORITY_UNTIL_END_STEP_BEFORE_MY_NEXT_TURN;
            case CANCEL -> PlayerAction.PASS_PRIORITY_CANCEL_ALL_ACTIONS;
        };
    }

    private void handle(ClientCallback cb) {
        if (!order.admit(cb)) {
            log.debug("stale {} #{} dropped — newer state already applied", cb.getMethod(), cb.getMessageId());
            return;
        }
        switch (cb.getMethod()) {
            case START_GAME -> startGame((TableClientMessage) cb.getData());
            case GAME_INIT -> {
                if (gameIdStr == null) {
                    gameId = cb.getObjectId();
                    gameIdStr = gameId.toString();
                    flushPreGameLog();
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
                if (!order.behind(cb)) {
                    updateState(msg.getGameView());
                }
                logLine(LogEntry.Kind.PERSONAL, null, night.bridge.translate.Html.strip(msg.getMessage()), null, null);
            }
            case CHATMESSAGE -> chat((ChatMessage) cb.getData());

            case GAME_ASK -> {
                GameClientMessage msg = (GameClientMessage) cb.getData();
                updateState(msg.getGameView());
                GamePrompt prompt = PromptTranslator.confirm(fsm.nextPromptId(), msg);
                if (mulligan.open() && MulliganWindow.isMulliganAsk(prompt)) {
                    mulliganAsk(prompt);
                } else {
                    dialog(prompt);
                }
            }
            case GAME_SELECT -> {
                GameClientMessage msg = (GameClientMessage) cb.getData();
                // updateState first: a combat ask's declared list reads lastState,
                // which must be the same combat view the client just received
                updateState(msg.getGameView());
                dialog(PromptTranslator.priority(fsm.nextPromptId(), msg, msg.getGameView(),
                        lastState, playerId == null ? null : playerId.toString()));
            }
            case GAME_TARGET -> {
                GameClientMessage msg = (GameClientMessage) cb.getData();
                updateState(msg.getGameView());
                dialog(PromptTranslator.chooseTargets(fsm.nextPromptId(), msg));
            }
            case GAME_PLAY_MANA -> {
                GameClientMessage msg = (GameClientMessage) cb.getData();
                updateState(msg.getGameView());
                dialog(PromptTranslator.payMana(fsm.nextPromptId(), msg, msg.getGameView()));
            }
            case GAME_CHOOSE_ABILITY -> {
                AbilityPickerView picker = (AbilityPickerView) cb.getData();
                updateState(picker.getGameView());
                dialog(PromptTranslator.chooseAbility(fsm.nextPromptId(), picker));
            }
            case GAME_CHOOSE_CHOICE -> {
                GameClientMessage msg = (GameClientMessage) cb.getData();
                updateState(msg.getGameView());
                dialog(PromptTranslator.chooseOption(fsm.nextPromptId(), msg));
            }
            case GAME_CHOOSE_PILE -> {
                GameClientMessage msg = (GameClientMessage) cb.getData();
                updateState(msg.getGameView());
                dialog(PromptTranslator.choosePile(fsm.nextPromptId(), msg));
            }
            case GAME_GET_AMOUNT -> {
                GameClientMessage msg = (GameClientMessage) cb.getData();
                updateState(msg.getGameView());
                dialog(PromptTranslator.chooseAmount(fsm.nextPromptId(), msg));
            }
            case GAME_GET_MULTI_AMOUNT -> {
                // Provisional — never observed live (design §8); tap will confirm shapes.
                log.warn("GAME_GET_MULTI_AMOUNT observed live — capture this game's tap for §16.1");
                GameClientMessage msg = (GameClientMessage) cb.getData();
                updateState(msg.getGameView());
                dialog(PromptTranslator.distribute(fsm.nextPromptId(), msg, msg.getGameView()));
            }
            case GAME_PLAY_XMANA -> {
                // Dead code in the 1.4.60 server (no callers); mapped defensively (protocol §15).
                log.warn("GAME_PLAY_XMANA observed live despite having no 1.4.60 call sites");
                GameClientMessage msg = (GameClientMessage) cb.getData();
                updateState(msg.getGameView());
                dialog(PromptTranslator.confirm(fsm.nextPromptId(), msg));
            }
            case USER_REQUEST_DIALOG -> {
                if (cb.getData() instanceof UserRequestMessage msg) {
                    userRequest(msg);
                }
            }

            case GAME_ERROR -> {
                String text = String.valueOf(cb.getData());
                sink.send(Err.of(ErrorCode.UPSTREAM_ERROR, text));
                logLine(LogEntry.Kind.ERROR, null, text, null, null);
                if (GameCoordinator.endsGameOnError(text)) {
                    serverErrorEnd();
                }
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

            case JOINED_TABLE, GAME_REDRAW_GUI, SHOW_USERMESSAGE, SERVER_MESSAGE -> {
                // table plumbing / GUI hints — nothing to relay
            }
            default -> log.debug("ignoring callback {}", cb.getMethod());
        }
        offerMulligan();
    }

    /**
     * XMage asks this seat to keep or mulligan (protocol §8). If the seat already answered
     * early, relay that answer now and show nothing. If its early prompt is still open, that
     * prompt simply becomes the live one. Otherwise present XMage's ask as usual.
     */
    private void mulliganAsk(GamePrompt prompt) {
        Boolean held = fsm.takeHeld();
        if (held != null) {
            askCount++;
            answers.bool(held);   // XmageAnswers paces it ≥150 ms after the ask
            mulligan.decided(held);
            log.debug("mulligan ask answered from the held early decision: {}", held ? "mulligan" : "keep");
            return;
        }
        if (fsm.preAskPending()) {
            if (fsm.pending().message().equals(prompt.message())) {
                askCount++;
                fsm.adoptPreAsk();
                log.debug("mulligan ask adopted early prompt {}", fsm.pending().promptId());
                return;
            }
            log.warn("early mulligan text '{}' != XMage's '{}' — re-presenting",
                    fsm.pending().message(), prompt.message());
        }
        dialog(prompt);   // supersedes a mismatched early prompt
        mulligan.asked(lastState);
    }

    /**
     * After every callback: if this seat is idle in the mulligan window with a fresh, final
     * hand, ask it now instead of waiting for XMage to reach it in turn order (protocol §8).
     * When the window closes, anything early that's left is withdrawn.
     */
    private void offerMulligan() {
        if (fsm == null || lastState == null || over || !mulligan.open()) {
            return;
        }
        if (mulligan.closesOn(lastState)) {
            GamePrompt withdrawn = fsm.withdrawPreAsk();
            if (withdrawn != null) {
                promptDone(withdrawn.promptId(), PromptDone.Reason.SUPERSEDED);
            }
            if (fsm.takeHeld() != null) {
                log.warn("mulligan window closed with an early decision XMage never asked for");
            }
            return;
        }
        if (recovering || fsm.pending() != null || fsm.replaying() || fsm.hasHeld()) {
            return;
        }
        String message = mulligan.offer(lastState);
        if (message == null) {
            return;
        }
        GamePrompt prompt = GamePrompt.confirm(fsm.nextPromptId(), message,
                MulliganWindow.YES_TEXT, MulliganWindow.NO_TEXT).emitted(store.nextSeq(), gameIdStr);
        fsm.presentPreAsk(prompt);
        sink.send(prompt);
        log.debug("early mulligan ask {}: {}", prompt.promptId(), message);
        driver.onPrompt(prompt, lastState);
    }

    private void startGame(TableClientMessage msg) {
        gameId = msg.getGameId();
        playerId = msg.getPlayerId();
        gameIdStr = gameId.toString();
        flushPreGameLog();
        answers = new XmageAnswers(xmage.session(), gameId, playerId, () -> lastCallbackNanos);
        fsm = new PromptFsm(answers);
        joinGameAndChat();
        coordinator.gameKnown(gameId);
        log.info("joined game {} as player {}", gameId, playerId);
    }

    private void updateState(GameView view) {
        if (view == null || gameIdStr == null) {
            return;
        }
        GameState prev = lastState;
        // The raw view's reveal windows flicker (server clears them after every
        // fire) — the latch stabilizes them before anything downstream looks.
        lastState = revealLatch.apply(
                ViewTranslator.translate(view, gameIdStr, playerId, this::displayName));
        List<GameEvent> events = EventDeriver.derive(prev, lastState, pendingLog);
        List<ServerMsg> msgs = store.update(gameIdStr, lastState, keyframesOnly.getAsBoolean(), events);
        if (!msgs.isEmpty()) {
            // The buffered log fed this transition; an empty delta consumed none, so
            // hold the lines for the update that actually carries their state.
            pendingLog.clear();
        }
        msgs.forEach(sink::send);
    }

    /** Every positional dialog flows through the FSM's replay interception (§8). */
    private void dialog(GamePrompt rawPrompt) {
        // Rename here, before the FSM stores it: a prompt replayed on resume
        // must read the same as the one it replaces (protocol §5).
        GamePrompt prompt = PromptNames.rewrite(rawPrompt, this::rewriteNames);
        askCount++;
        PromptFsm.Flow flow = fsm.onDialog(prompt);
        log.debug("ask #{} {} promptId={} -> {}", askCount, prompt.kind(), prompt.promptId(),
                flow.getClass().getSimpleName());
        switch (flow) {
            case PromptFsm.Flow.Present() -> present(prompt);
            case PromptFsm.Flow.Consumed() -> {
                // replay continuation sent; nothing to show
            }
            case PromptFsm.Flow.Completed(long promptId) -> {
                promptDone(promptId, PromptDone.Reason.ANSWERED);
                presentDeferred();
            }
            case PromptFsm.Flow.CompletedThenPresent(long promptId) -> {
                promptDone(promptId, PromptDone.Reason.ANSWERED);
                present(prompt);
                presentDeferred();
            }
            case PromptFsm.Flow.Aborted(long promptId) -> {
                promptDone(promptId, PromptDone.Reason.SUPERSEDED);
                present(prompt);
                presentDeferred();
            }
        }
    }

    private void present(GamePrompt prompt) {
        present(prompt, null);
    }

    private void present(GamePrompt prompt, UUID requestData) {
        if (over) {
            return;
        }
        GamePrompt superseded = fsm.pending();
        if (superseded != null) {
            if (fsm.preAskPending()) {
                mulligan.withdrawn();   // unanswered; offer that hand again when idle
            }
            promptDone(superseded.promptId(), PromptDone.Reason.SUPERSEDED);
        }
        GamePrompt emitted = prompt.emitted(store.nextSeq(), gameIdStr);
        fsm.present(emitted, requestData);
        sink.send(emitted);
        // Bridge-hosted AI seats decide here (design: the AI is another answer
        // source); NONE for browser seats, which answer over the wire. This is the
        // single choke point for every real presentation — regroundBrowser() and
        // replayForResume() re-emit via sink.send directly, so a resume never
        // re-triggers a decision.
        driver.onPrompt(emitted, lastState);
    }

    /**
     * USER_REQUEST_DIALOG is out-of-band (answered via sendPlayerAction, not
     * the positional channel): deferred while a replay is in flight, and a
     * button-less message degrades to a status log line.
     */
    private void userRequest(UserRequestMessage msg) {
        if (over || fsm == null) {
            return;
        }
        if (msg.getGameId() != null && gameId != null && !msg.getGameId().equals(gameId)) {
            log.debug("ignoring user request for foreign game {}", msg.getGameId());
            return;
        }
        GamePrompt prompt = PromptTranslator.playerRequest(fsm.nextPromptId(), msg);
        if (prompt.options().isEmpty()) {
            logLine(LogEntry.Kind.STATUS, null, prompt.message(), null, null);
            return;
        }
        if (fsm.replaying()) {
            deferredRequest = prompt;
            deferredRequestData = msg.getRelatedUserId();
            return;
        }
        present(prompt, msg.getRelatedUserId());
    }

    private void presentDeferred() {
        if (deferredRequest == null || over) {
            deferredRequest = null;
            deferredRequestData = null;
            return;
        }
        GamePrompt prompt = deferredRequest;
        UUID data = deferredRequestData;
        deferredRequest = null;
        deferredRequestData = null;
        present(prompt, data);
    }

    private void promptDone(long promptId, PromptDone.Reason reason) {
        sink.send(new PromptDone(store.nextSeq(), gameIdStr, promptId, reason));
    }

    private void chat(ChatMessage msg) {
        LogTranslator.chat(msg).ifPresent(line ->
                logLine(line.kind(), line.turn(), line.text(), line.refs(), resolvePlayer(line.username())));
        if (GameCoordinator.endsGameOnError(msg.getMessage())) {
            serverErrorEnd(); // the "technical winner" inform
        }
    }

    /**
     * The game died on a server error (protocol §11). Before game.over this just
     * flags the outcome. After it, the signal came late: 1.4.63 queues error and chat
     * callbacks behind GAME_OVER when the seat is backed up. So the game.over this
     * seat sent may name XMage's technical winner, and it's re-sent corrected.
     */
    private void serverErrorEnd() {
        coordinator.recordServerError();
        if (gameOverMsg == null) {
            return;
        }
        GameCoordinator.Outcome outcome = coordinator.outcome();
        // compare before building: building takes a seq, and an unsent seq is a gap
        if (!winners(outcome).equals(gameOverMsg.winnerPlayerIds())
                || !rewriteNames(Html.strip(outcome.reason())).equals(gameOverMsg.reason())) {
            gameOverMsg = gameOverMsg(outcome);
            sink.send(gameOverMsg);
            log.info("game over corrected for this seat: {}", gameOverMsg.reason());
        }
    }

    private void logLine(LogEntry.Kind kind, String turn, String text,
                         List<LogEntry.Ref> refs, String playerId) {
        if (gameIdStr == null) {
            // protocol §10: game.log carries a required gameId. Callbacks can
            // race ahead of START_GAME/GAME_INIT (observed live 2026-07-18: a
            // line reached the wire with no gameId) — hold them until the id
            // is known, then flush in order.
            preGameLog.add(new PendingLogLine(kind, turn, text, refs, playerId));
            return;
        }
        LogEntry entry = new LogEntry(store.nextSeq(), gameIdStr, System.currentTimeMillis(),
                kind, turn, rewriteNames(text), refs, playerId);
        logRing.addLast(entry);
        if (logRing.size() > logRingCapacity) {
            logRing.removeFirst();
        }
        // Buffer for the M6 event join; drained by the next non-empty state emit. Bounded
        // by the same capacity in case a burst of log lines outruns state updates.
        pendingLog.add(entry);
        if (pendingLog.size() > logRingCapacity) {
            pendingLog.removeFirst();
        }
        sink.send(entry);
    }

    private void flushPreGameLog() {
        if (preGameLog.isEmpty()) {
            return;
        }
        List<PendingLogLine> held = List.copyOf(preGameLog);
        preGameLog.clear();
        for (PendingLogLine line : held) {
            logLine(line.kind(), line.turn(), line.text(), line.refs(), line.playerId());
        }
    }

    private record PendingLogLine(LogEntry.Kind kind, String turn, String text,
                                  List<LogEntry.Ref> refs, String playerId) {
    }

    private String resolvePlayer(String username) {
        if (username == null || lastState == null) {
            return null;
        }
        String display = displayName(username);   // lastState carries display names
        for (Player p : lastState.players()) {
            if (p.name().equals(display)) {
                return p.id();
            }
        }
        return null;
    }

    // XMage username → lobby display name. Seats are fixed before startMatch,
    // so the map is cached on first use (pump-thread only). Applied to state
    // (ViewTranslator), log lines, the game-over reason, and every prompt's
    // player-facing text (PromptNames, at the dialog() choke point).
    private Map<String, String> displayNames;

    private String displayName(String username) {
        if (displayNames == null) {
            displayNames = coordinator.displayNames();
        }
        return displayNames.getOrDefault(username, username);
    }

    /** XMage log/chat text embeds cn_* usernames; the wire speaks display names. */
    private String rewriteNames(String text) {
        if (text == null) {
            return null;
        }
        if (displayNames == null) {
            displayNames = coordinator.displayNames();
        }
        String out = text;
        for (Map.Entry<String, String> e : displayNames.entrySet()) {
            out = out.replace(e.getKey(), e.getValue());
        }
        return out;
    }

    private void finish() {
        if (over || gameIdStr == null) {
            return;
        }
        over = true;
        deferredRequest = null;
        deferredRequestData = null;
        GameCoordinator.Outcome outcome = coordinator.outcome();
        if (lastState != null) {
            lastState = lastState.over();
            // protocol §11: a final keyframe precedes game.over — never a patch
            // (keyframesOnly=true, so update() emits at most one keyframe)
            List<ServerMsg> finals = store.update(gameIdStr, lastState, true);
            if (finals.isEmpty()) {
                store.forceKeyframe(gameIdStr).ifPresent(sink::send);
            } else {
                finals.forEach(sink::send);
            }
        }
        if (fsm != null && fsm.pending() != null) {
            promptDone(fsm.pending().promptId(), PromptDone.Reason.GAME_OVER);
        }
        if (fsm != null) {
            fsm.clear();
        }
        gameOverMsg = gameOverMsg(outcome);
        sink.send(gameOverMsg);
        log.info("game over for this seat: {} ({} stale updates dropped)", outcome.reason(), order.dropped());
        coordinator.seatFinished();
    }

    private GameOver gameOverMsg(GameCoordinator.Outcome outcome) {
        return new GameOver(store.nextSeq(), gameIdStr, winners(outcome),
                rewriteNames(Html.strip(outcome.reason())), true);
    }

    private List<String> winners(GameCoordinator.Outcome outcome) {
        List<String> ids = new ArrayList<>();
        if (outcome.winnerName() != null && lastState != null) {
            String display = displayName(outcome.winnerName());   // lastState carries display names
            for (Player p : lastState.players()) {
                if (p.name().equals(display)) {
                    ids.add(p.id());
                }
            }
        }
        return ids;
    }

    @Override
    public void close() {
        driver.close();
        exec.close();
    }
}
