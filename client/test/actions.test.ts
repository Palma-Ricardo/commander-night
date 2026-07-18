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
let scripted: (cmd: ClientMsg) => CommandReply | Promise<CommandReply>;
let actions: Actions;

const fakeManager: SocketManager = {
  connect() {},
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

describe('persistence', () => {
  it('display name and deck text persist under cn.*', () => {
    actions.setDisplayName('Ricardo');
    actions.setDeckText('1 [C21:263] Command Tower');
    expect(kv.get(KEYS.name)).toBe('Ricardo');
    expect(kv.get(KEYS.deck)).toBe('1 [C21:263] Command Tower');
  });

  it('keyframes toggle flips and persists', () => {
    expect(stores.settings.getState().keyframesMode).toBe(true);
    actions.toggleKeyframesMode();
    expect(stores.settings.getState().keyframesMode).toBe(false);
    expect(JSON.parse(kv.get(KEYS.settings)!)).toEqual({ keyframesMode: false });
  });
});
