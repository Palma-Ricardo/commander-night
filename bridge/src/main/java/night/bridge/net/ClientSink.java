package night.bridge.net;

import night.bridge.proto.ServerMsg;

/**
 * Where a seat's events go: resolved per user through the session registry,
 * so pumps stay ignorant of connection churn. Sends to a user with no live
 * connection are dropped — resume (M4) replays state from the pump's side.
 */
public interface ClientSink {

    void send(ServerMsg msg);
}
