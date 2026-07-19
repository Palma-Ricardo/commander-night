// Action tests (design §4/§10): the create→code→join chain, per-command error
// surfacing, and user-input persistence.

import { beforeEach, describe, expect, it } from 'vitest';
import { CommandError, createActions, type Actions } from '../src/net/actions';
import type { CommandReply } from '../src/net/pending';
import type { SocketManager } from '../src/net/socket';
import type { ClientMsg } from '../src/protocol/protocol';
import { createStores, type Stores } from '../src/stores';
import { KEYS, memoryKV, type KV } from '../src/stores/storage';

let kv: KV;
let stores: Stores;
let sent: ClientMsg[];
let connects: number;
let scripted: (cmd: ClientMsg) => CommandReply | Promise<CommandReply>;
let actions: Actions;

const fakeManager: SocketManager = {
  connect() { connects++; },
  disconnect() {},
  resyncNow() {},
  dispose() {},
  send(cmd) {
    sent.push(cmd);
    return Promise.resolve(scripted(cmd));
  },
};

beforeEach(() => {
  kv = memoryKV();
  stores = createStores(kv);
  sent = [];
  connects = 0;
  scripted = cmd => ({ t: 'ack', re: cmd.id });
  actions = createActions(stores, fakeManager, kv);
});

describe('createLobby', () => {
  it('chains create → lobby.state code → join with the display name', async () => {
    actions.setDisplayName('Ricardo');
    scripted = cmd => {
      if (cmd.t === 'lobby.create') {
        // the code arrives via the lobby.state broadcast right after the ack (§5)
        queueMicrotask(() => stores.lobby.setState({
          state: { t: 'lobby.state', code: 'AB12CD', hostUserId: 'u1', seats: [] },
        }));
      }
      return { t: 'ack', re: cmd.id };
    };

    const code = await actions.createLobby();
    expect(code).toBe('AB12CD');
    expect(sent.map(c => c.t)).toEqual(['lobby.create', 'lobby.join']);
    expect(sent[1]).toMatchObject({ code: 'AB12CD', displayName: 'Ricardo' });
  });

  it('refuses without a display name', async () => {
    await expect(actions.createLobby()).rejects.toThrow('display name');
    expect(sent).toEqual([]);
  });

  it('surfaces a command error from the bridge', async () => {
    actions.setDisplayName('Ricardo');
    scripted = cmd => ({ t: 'error', re: cmd.id, code: 'LOBBY_STATE', message: 'already in a lobby' });
    await expect(actions.createLobby()).rejects.toThrow('already in a lobby');
  });
});

describe('joinLobby / submitDeck', () => {
  it('normalizes the code and sends the stored name', async () => {
    actions.setDisplayName('Marta');
    await actions.joinLobby('  xk cd42 '.replace(/ /g, ''));   // "xkcd42"
    expect(sent[0]).toMatchObject({ t: 'lobby.join', code: 'XKCD42', displayName: 'Marta' });
  });

  it('submitDeck sends the persisted deck text and surfaces DECK_INVALID inline', async () => {
    actions.setDeckText('1 [C21:263] Command Tower');
    await actions.submitDeck();
    expect(sent[0]).toMatchObject({ t: 'lobby.deck', format: 'dck', content: '1 [C21:263] Command Tower' });

    scripted = cmd => ({ t: 'error', re: cmd.id, code: 'DECK_INVALID', message: 'deck content is empty' });
    const err = await actions.submitDeck().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).code).toBe('DECK_INVALID');
  });
});

describe('leaveGame (play again, protocol §5)', () => {
  it('resets game/log/prompt/lobby stores but keeps name, deck, and session', () => {
    actions.setDisplayName('Ricardo');
    actions.setDeckText('1 [C21:263] Command Tower');
    stores.session.setState({ token: 't-1', userId: 'u1' });
    stores.lobby.setState({ state: { t: 'lobby.state', code: 'AB12CD', hostUserId: 'u1', seats: [] } });
    stores.game.setState({
      state: { gameId: 'g1' } as never, lastAppliedSeq: 41, syncMode: 'live',
      over: { t: 'game.over', gameId: 'g1', seq: 42, reason: 'x', winnerPlayerIds: [], finalState: true },
    });
    stores.log.setState({ entries: [{ t: 'game.log', gameId: 'g1', seq: 1, ts: 0, kind: 'game', text: 'hi' }] });
    stores.session.setState({ resume: { gameId: 'g1', lastSeq: 42 } });
    kv.set(KEYS.resume, JSON.stringify({ gameId: 'g1', lastSeq: 42 }));

    actions.leaveGame();

    expect(stores.game.getState()).toMatchObject({ state: undefined, over: undefined, lastAppliedSeq: -1 });
    expect(stores.log.getState().entries).toEqual([]);
    expect(stores.prompt.getState().pending).toBeUndefined();
    expect(stores.lobby.getState().state).toBeUndefined();
    expect(stores.session.getState()).toMatchObject({ token: 't-1', userId: 'u1' });
    expect(stores.session.getState().resume).toBeUndefined();   // deliberate walk-away (§10)
    expect(kv.get(KEYS.resume)).toBeNull();
    expect(kv.get(KEYS.name)).toBe('Ricardo');
    expect(kv.get(KEYS.deck)).toBe('1 [C21:263] Command Tower');
  });
});

describe('turn-control actions (§9 game.action)', () => {
  beforeEach(() => {
    stores.game.setState({ state: { gameId: 'g1' } as never });
  });

  it('setSkip sends the mode; the toggle renders from me.skip, not from here', async () => {
    await actions.setSkip('endOfTurn');
    expect(sent[0]).toMatchObject({ t: 'game.action', gameId: 'g1', action: { kind: 'skip', mode: 'endOfTurn' } });
    await actions.setSkip('cancel');
    expect(sent[1]).toMatchObject({ action: { kind: 'skip', mode: 'cancel' } });
    expect(stores.game.getState().state).toMatchObject({ gameId: 'g1' });   // no local skip write
  });

  it('setAutoMana stores the ack-confirmed value (no state echo exists)', async () => {
    expect(stores.game.getState().autoMana).toBe(true);
    await actions.setAutoMana(false);
    expect(sent[0]).toMatchObject({ action: { kind: 'autoMana', enabled: false } });
    expect(stores.game.getState().autoMana).toBe(false);
  });

  it('setAutoMana keeps the old value when the bridge rejects it', async () => {
    scripted = cmd => ({ t: 'error', re: cmd.id, code: 'UPSTREAM_ERROR', message: 'nope' });
    await expect(actions.setAutoMana(false)).rejects.toThrow('nope');
    expect(stores.game.getState().autoMana).toBe(true);
  });

  it('requestRollback and resetTriggerOrder send their §9 shapes', async () => {
    await actions.requestRollback(1);
    await actions.resetTriggerOrder();
    expect(sent[0]).toMatchObject({ action: { kind: 'requestRollback', turns: 1 } });
    expect(sent[1]).toMatchObject({ action: { kind: 'triggerOrder', mode: 'reset' } });
  });

  it('all §9 senders no-op outside a game', async () => {
    stores.game.setState({ state: undefined });
    await actions.setSkip('stack');
    await actions.concede();
    expect(sent).toEqual([]);
  });
});

describe('chat (§8, protocol §10)', () => {
  beforeEach(() => {
    stores.game.setState({ state: { gameId: 'g1' } as never });
  });

  it('trims and sends; renders nothing locally (echo-only, §4)', async () => {
    await actions.sendChat('  gg wp  ');
    expect(sent[0]).toMatchObject({ t: 'chat.send', gameId: 'g1', text: 'gg wp' });
    expect(stores.log.getState().entries).toEqual([]);
  });

  it('no-ops on empty text or outside a game', async () => {
    await actions.sendChat('   ');
    stores.game.setState({ state: undefined });
    await actions.sendChat('hello?');
    expect(sent).toEqual([]);
  });

  it('markChatRead zeroes the unread badge', () => {
    stores.log.setState({ unreadChat: 3 });
    actions.markChatRead();
    expect(stores.log.getState().unreadChat).toBe(0);
  });
});

describe('rematch flow (§10 — pure client convention)', () => {
  beforeEach(() => {
    actions.setDisplayName('Ricardo');
    actions.setDeckText('1 [C21:263] Command Tower');
    stores.game.setState({ state: { gameId: 'g-old' } as never });
    stores.session.setState({ resume: { gameId: 'g-old', lastSeq: 99 } });
    kv.set(KEYS.resume, JSON.stringify({ gameId: 'g-old', lastSeq: 99 }));
    stores.lobby.setState({ state: { t: 'lobby.state', code: 'OLD123', hostUserId: 'u1', seats: [] } });
    scripted = cmd => {
      if (cmd.t === 'lobby.create') {
        queueMicrotask(() => stores.lobby.setState({
          state: { t: 'lobby.state', code: 'NEW456', hostUserId: 'u1', seats: [] },
        }));
      }
      return { t: 'ack', re: cmd.id };
    };
  });

  it('host: create → join → "Rematch → CODE" into the old game chat → fresh stores, lobby kept, deck resubmitted', async () => {
    const code = await actions.rematch();
    expect(code).toBe('NEW456');
    expect(sent.map(c => c.t)).toEqual(['lobby.create', 'lobby.join', 'chat.send', 'lobby.deck']);
    expect(sent[2]).toMatchObject({ gameId: 'g-old', text: 'Rematch → NEW456' });
    expect(stores.game.getState().state).toBeUndefined();
    expect(stores.lobby.getState().state?.code).toBe('NEW456');
    expect(stores.session.getState().resume).toBeUndefined();   // no resume into the dead game
    expect(kv.get(KEYS.resume)).toBeNull();
  });

  it('a failed chat announce is surfaced, not swallowed — the host must know to read the code out', async () => {
    scripted = cmd => {
      if (cmd.t === 'lobby.create') {
        queueMicrotask(() => stores.lobby.setState({
          state: { t: 'lobby.state', code: 'NEW456', hostUserId: 'u1', seats: [] },
        }));
      }
      if (cmd.t === 'chat.send') {
        return { t: 'error', re: cmd.id, code: 'UNKNOWN_GAME', message: 'game torn down' };
      }
      return { t: 'ack', re: cmd.id };
    };
    const code = await actions.rematch();     // still succeeds — the lobby exists
    expect(code).toBe('NEW456');
    expect(stores.notices.getState().toasts).toMatchObject([
      { kind: 'error', text: expect.stringContaining('NEW456') as unknown as string },
    ]);
  });

  it('guest: joinRematch joins, waits for the lobby, resets keeping it, and resubmits the deck', async () => {
    scripted = cmd => {
      if (cmd.t === 'lobby.join') {
        queueMicrotask(() => stores.lobby.setState({
          state: { t: 'lobby.state', code: 'NEW456', hostUserId: 'u1', seats: [] },
        }));
      }
      return { t: 'ack', re: cmd.id };
    };
    await actions.joinRematch('NEW456');
    expect(sent.map(c => c.t)).toEqual(['lobby.join', 'lobby.deck']);
    expect(sent[0]).toMatchObject({ code: 'NEW456', displayName: 'Ricardo' });
    expect(stores.game.getState().state).toBeUndefined();
    expect(stores.lobby.getState().state?.code).toBe('NEW456');
    expect(stores.session.getState().resume).toBeUndefined();
  });
});

describe('returnToGame (§10 rejoin affordance)', () => {
  it('ready session: resyncs the anchored game — the keyframe re-opens the screen', async () => {
    stores.connection.setState({ status: 'ready' });
    stores.session.setState({ resume: { gameId: 'g1', lastSeq: 41 } });
    await actions.returnToGame();
    expect(sent[0]).toMatchObject({ t: 'game.resync', gameId: 'g1' });
  });

  it('a dead game drops the anchor so the affordance stops dangling', async () => {
    stores.connection.setState({ status: 'ready' });
    stores.session.setState({ resume: { gameId: 'g1', lastSeq: 41 } });
    kv.set(KEYS.resume, JSON.stringify({ gameId: 'g1', lastSeq: 41 }));
    scripted = cmd => ({ t: 'error', re: cmd.id, code: 'UNKNOWN_GAME', message: 'gone' });
    await expect(actions.returnToGame()).rejects.toThrow('gone');
    expect(stores.session.getState().resume).toBeUndefined();
    expect(kv.get(KEYS.resume)).toBeNull();
  });

  it('not ready: reconnects instead (hello carries the anchor)', async () => {
    stores.connection.setState({ status: 'idle' });
    stores.session.setState({ resume: { gameId: 'g1', lastSeq: 41 } });
    await actions.returnToGame();
    expect(connects).toBe(1);
    expect(sent).toEqual([]);
  });
});

describe('submitDeck image warm-up (C5)', () => {
  it('queues every deck identity at pile priority on submit', async () => {
    const warmed: { set: string; number: string; name: string; priority: number }[] = [];
    const warmActions = createActions(stores, fakeManager, kv, {
      scryfall: { resolve: (card, priority) => warmed.push({ ...card, priority }) },
    });
    warmActions.setDeckText('1 [MKC:145] Agitator Ant\nSB: 1 [NEC:1] Chishiro\n');

    await warmActions.submitDeck();

    expect(warmed).toEqual([
      { set: 'MKC', number: '145', name: 'Agitator Ant', priority: 2 },
      { set: 'NEC', number: '1', name: 'Chishiro', priority: 2 },
    ]);
  });

  it('still submits the deck when no resolver is wired', async () => {
    actions.setDeckText('1 [MKC:145] Agitator Ant\n');
    await actions.submitDeck();
    expect(sent.some(c => c.t === 'lobby.deck')).toBe(true);
  });

  it('does not warm when the deck text is empty', async () => {
    const warmed: unknown[] = [];
    const warmActions = createActions(stores, fakeManager, kv, {
      scryfall: { resolve: () => warmed.push(1) },
    });
    warmActions.setDeckText('');
    await warmActions.submitDeck();
    expect(warmed).toHaveLength(0);
  });
});

describe('persistence', () => {
  it('display name and deck text persist under cn.*', () => {
    actions.setDisplayName('Ricardo');
    actions.setDeckText('1 [C21:263] Command Tower');
    expect(kv.get(KEYS.name)).toBe('Ricardo');
    expect(kv.get(KEYS.deck)).toBe('1 [C21:263] Command Tower');
  });

  it('keyframes toggle flips and persists (patch mode is the C3 default)', () => {
    expect(stores.settings.getState().keyframesMode).toBe(false);
    actions.toggleKeyframesMode();
    expect(stores.settings.getState().keyframesMode).toBe(true);
    expect(JSON.parse(kv.get(KEYS.settings)!)).toEqual({ v: 3, keyframesMode: true });
  });
});
