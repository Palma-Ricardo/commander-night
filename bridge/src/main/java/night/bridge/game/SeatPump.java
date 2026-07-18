package night.bridge.game;

import mage.constants.PlayerAction;
import mage.interfaces.callback.ClientCallback;
import mage.view.AbilityPickerView;
import mage.view.ChatMessage;
import mage.view.GameClientMessage;
import mage.view.GameEndView;
import mage.view.GameView;
import mage.view.TableClientMessage;
import mage.view.UserRequestMessage;
import night.bridge.net.ClientSink;
import night.bridge.proto.Ack;
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

    /**
     * Lost-wakeup watchdog (see {@link XmageAnswers} race doc): if no new ask
     * arrives for this long after we sent a positional answer, XMage's game
     * thread may be wedged in its predicate-less {@code response.wait()}
     * (jstack-verified against 1.4.60, 2026-07-17) and gets nudged with the
     * sentinel UUID — which every ask kind validates, rejects and re-fires. By
     * nudge time a wedged game thread is long parked in {@code wait()}, so
     * unlike a prompt-time answer the nudge's notify cannot be edge-lost. A
     * false positive (an AI thinking — live-observed at 30 s+ on big boards)
     * parks in XMage's {@code waitResponseOpen} spin and is rejected at the
     * next real ask, which simply re-fires — harmless. Because ask-silence is
     * NOT evidence of seat loss (transport loss is the session layer's job),
     * the watchdog never gives up: it keeps nudging with exponential backoff
     * up to {@link #NUDGE_MAX_DELAY_MILLIS} until an ask or game-over arrives.
     */
    private static final long NUDGE_DELAY_MILLIS = 6_000;
    private static final long NUDGE_MAX_DELAY_MILLIS = 60_000;

    private final ExecutorService exec;
    private final SeatSession xmage;
    private final ClientSink sink;
    private final GameCoordinator coordinator;
    private final StateStore store;
    private final BooleanSupplier keyframesOnly;
    private final Deque<LogEntry> logRing = new ArrayDeque<>();
    private final int logRingCapacity;

    /** When the seat last heard from XMage — written on callback threads, read by answer pacing. */
    private volatile long lastCallbackNanos = System.nanoTime();

    // Pump-thread state — no other thread reads or writes these.
    private UUID gameId;
    private UUID playerId;
    private String gameIdStr;
    private XmageAnswers answers;
    private PromptFsm fsm;
    private GameState lastState;
    private GamePrompt deferredRequest;
    private UUID deferredRequestData;
    private boolean over;
    /** Positional asks seen — the watchdog's only proof of life (see {@link #armNudge}). */
    private long askCount;
    private int nudges;

    public SeatPump(String seatLabel, SeatSession xmage, ClientSink sink,
                    GameCoordinator coordinator, int logRingCapacity,
                    int keyframeEvery, BooleanSupplier keyframesOnly) {
        this.exec = Executors.newSingleThreadExecutor(
                Thread.ofVirtual().name("seat-" + seatLabel).factory());
        this.xmage = xmage;
        this.sink = sink;
        this.coordinator = coordinator;
        this.logRingCapacity = logRingCapacity;
        this.store = new StateStore(keyframeEvery);
        this.keyframesOnly = keyframesOnly;
    }

    /** XMage-thread entry: decompressed callbacks, in arrival order. */
    public void onCallback(ClientCallback callback) {
        lastCallbackNanos = System.nanoTime();
        exec.execute(() -> {
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
        });
    }

    /** Jetty-thread entry: an answer command from this seat's browser. */
    public void answer(GameAnswer cmd, Consumer<ServerMsg> reply) {
        exec.execute(() -> {
            if (fsm == null) {
                reply.accept(Err.re(cmd.id(), ErrorCode.PROMPT_STALE, "the game has not started"));
                return;
            }
            PromptFsm.Outcome outcome = fsm.answer(cmd.promptId(), cmd.answer());
            log.debug("answer promptId={} -> {}", cmd.promptId(), outcome);
            switch (outcome) {
                case PromptFsm.Outcome.Rejected(ErrorCode code, String message) ->
                        reply.accept(Err.re(cmd.id(), code, message));
                case PromptFsm.Outcome.Applied(GamePrompt revived) -> {
                    reply.accept(new Ack(cmd.id()));
                    promptDone(cmd.promptId(), PromptDone.Reason.ANSWERED);
                    if (revived != null) {
                        // back to waiting on the client, not on XMage — don't arm
                        present(revived);
                    } else {
                        armNudge();
                    }
                }
                // whole-set replay in flight — promptDone follows its resolution (§8)
                case PromptFsm.Outcome.ReplayStarted() -> {
                    reply.accept(new Ack(cmd.id()));
                    armNudge();
                }
            }
        });
    }

    /** Jetty-thread entry: a prompt-free player action (protocol §9). */
    public void action(GameAction cmd, Consumer<ServerMsg> reply) {
        exec.execute(() -> {
            if (answers == null || over) {
                reply.accept(Err.re(cmd.id(), ErrorCode.UNKNOWN_GAME,
                        over ? "the game is over" : "the game has not started"));
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
        exec.execute(() -> {
            reply.accept(new Ack(cmd.id()));
            if (gameIdStr != null) {
                store.forceKeyframe(gameIdStr).ifPresent(sink::send);
            }
        });
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
                dialog(PromptTranslator.confirm(fsm.nextPromptId(), msg));
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
                dialog(PromptTranslator.distribute(fsm.nextPromptId(), msg));
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
    }

    /**
     * Arms the lost-wakeup watchdog after a positional answer left for XMage.
     * The only proof the game thread heard us is the <em>next ask</em> (or game
     * over): state updates and chat can keep flowing from other seats' activity
     * while the game thread stays wedged, so they must NOT stand the watchdog
     * down — it re-checks {@link #askCount} and keeps nudging through the noise
     * (benign on false positives; see field doc).
     */
    private void armNudge() {
        long armedAt = askCount;
        long delay = Math.min(NUDGE_DELAY_MILLIS << Math.min(nudges, 8), NUDGE_MAX_DELAY_MILLIS);
        log.debug("watchdog armed at ask #{} (delay {}ms, nudges {})", armedAt, delay, nudges);
        Thread.ofVirtual().name("nudge-" + xmage.username()).start(() -> {
            try {
                Thread.sleep(delay);
                exec.execute(() -> {
                    if (over || answers == null || askCount != armedAt) {
                        log.debug("watchdog stood down (over={} askCount={} armedAt={})",
                                over, askCount, armedAt);
                        return;
                    }
                    nudges++;
                    log.warn("no ask for {}ms after an answer — nudging XMage (#{})", delay, nudges);
                    answers.nudge();
                    armNudge();
                });
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (java.util.concurrent.RejectedExecutionException e) {
                // pump closed while we slept — nothing to guard anymore
            }
        });
    }

    private void startGame(TableClientMessage msg) {
        gameId = msg.getGameId();
        playerId = msg.getPlayerId();
        gameIdStr = gameId.toString();
        answers = new XmageAnswers(xmage.session(), gameId, playerId, () -> lastCallbackNanos);
        fsm = new PromptFsm(answers);
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
        store.update(gameIdStr, lastState, keyframesOnly.getAsBoolean()).ifPresent(sink::send);
    }

    /** Every positional dialog flows through the FSM's replay interception (§8). */
    private void dialog(GamePrompt prompt) {
        askCount++;
        nudges = 0;
        PromptFsm.Flow flow = fsm.onDialog(prompt);
        log.debug("ask #{} {} promptId={} -> {}", askCount, prompt.kind(), prompt.promptId(),
                flow.getClass().getSimpleName());
        switch (flow) {
            case PromptFsm.Flow.Present() -> present(prompt);
            case PromptFsm.Flow.Consumed() -> armNudge();
            case PromptFsm.Flow.Completed(long promptId) -> {
                promptDone(promptId, PromptDone.Reason.ANSWERED);
                presentDeferred();
                armNudge();
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
            promptDone(superseded.promptId(), PromptDone.Reason.SUPERSEDED);
        }
        GamePrompt emitted = prompt.emitted(store.nextSeq(), gameIdStr);
        fsm.present(emitted, requestData);
        sink.send(emitted);
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
            store.update(gameIdStr, lastState, true).ifPresentOrElse(sink::send,
                    () -> store.forceKeyframe(gameIdStr).ifPresent(sink::send));
        }
        if (fsm != null && fsm.pending() != null) {
            promptDone(fsm.pending().promptId(), PromptDone.Reason.GAME_OVER);
        }
        if (fsm != null) {
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
