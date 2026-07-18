// Conformance-corpus mirror test (design §13): the mirror image of the bridge's
// ProtocolSamplesTest.
//   server → client samples must DECODE through the codec, dev-strict — an unknown
//     field in a sample is a spec bug, not forward compatibility.
//   client → server samples must be REPRODUCED by the commands.ts builders with a
//     pinned id mint, matching the sample JSON exactly (modulo key order).
// Every corpus file must be covered by one of the two directions; a corpus change
// breaks whichever codebase didn't follow.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/protocol/codec';
import * as cmd from '../src/protocol/commands';
import type { CommandContext } from '../src/protocol/commands';
import type { ClientMsg } from '../src/protocol/protocol';

const samplesDir = fileURLToPath(new URL('../../docs/protocol/samples/', import.meta.url));
const files = fs.readdirSync(samplesDir).filter(f => f.endsWith('.json')).sort();

const SERVER_TYPES = new Set([
  'session.welcome', 'ack', 'error', 'lobby.state',
  'game.state', 'game.patch', 'game.prompt', 'game.promptDone', 'game.log', 'game.over',
]);

// filename → builder invocation reproducing it. The mint is pinned to the sample's
// own id (ids are injected, protocol §3); every other argument is spelled out here.
const builders: Record<string, (c: CommandContext) => ClientMsg> = {
  'session.hello.fresh.json': c => cmd.hello(c),
  'session.hello.resume.json': c => cmd.hello(c, {
    token: 'kZ1xW3vJqL8mN5aPbT9cDg',
    resume: { gameId: '3f2a9d1e-6c47-4b2e-9a10-8e5d21f7b0c4', lastSeq: 812 },
  }),
  'session.hello.keyframes.json': c => cmd.hello(c, {
    token: 'kZ1xW3vJqL8mN5aPbT9cDg', stateMode: 'keyframes',
  }),
  'lobby.create.json': c => cmd.lobbyCreate(c, { name: 'Tuesday Night' }),
  'lobby.join.json': c => cmd.lobbyJoin(c, { code: 'XKCD42', displayName: 'Ricardo' }),
  'lobby.deck.json': c => cmd.lobbyDeck(c, {
    format: 'dck',
    content: '1 [C21:263] Command Tower\nSB: 1 [KHM:222] Lathril, Blade of the Elves',
  }),
  'lobby.ready.json': c => cmd.lobbyReady(c, { ready: true }),
  'lobby.start.json': c => cmd.lobbyStart(c, { fillAI: true }),
  'game.resync.json': c => cmd.gameResync(c, { gameId: 'g1' }),
  'chat.send.json': c => cmd.chatSend(c, { gameId: 'g1', text: 'gg — that Lathril swing was brutal' }),

  'game.answer.confirm.json': c => cmd.gameAnswer(c, {
    gameId: 'g1', promptId: 41, answer: { type: 'confirm', value: false },
  }),
  'game.answer.object.json': c => cmd.gameAnswer(c, {
    gameId: 'g1', promptId: 42, answer: { type: 'object', objectId: '3f2a9d1e-6c47-4b2e-9a10-8e5d21f7b0c4' },
  }),
  'game.answer.mana.json': c => cmd.gameAnswer(c, {
    gameId: 'g1', promptId: 43, answer: { type: 'mana', color: 'U' },
  }),
  'game.answer.cancel.json': c => cmd.gameAnswer(c, {
    gameId: 'g1', promptId: 44, answer: { type: 'cancel' },
  }),
  'game.answer.objects.json': c => cmd.gameAnswer(c, {
    gameId: 'g1', promptId: 45, answer: { type: 'objects', objectIds: ['aaa-1', 'bbb-2'] },
  }),
  'game.answer.number.json': c => cmd.gameAnswer(c, {
    gameId: 'g1', promptId: 46, answer: { type: 'number', value: 7 },
  }),
  'game.answer.option.json': c => cmd.gameAnswer(c, {
    gameId: 'g1', promptId: 47, answer: { type: 'option', key: 'Shade' },
  }),
  'game.answer.pile.json': c => cmd.gameAnswer(c, {
    gameId: 'g1', promptId: 48, answer: { type: 'pile', index: 1 },
  }),
  'game.answer.distribution.json': c => cmd.gameAnswer(c, {
    gameId: 'g1', promptId: 49,
    answer: { type: 'distribution', amounts: [{ id: '0', amount: 3 }, { id: '1', amount: 1 }] },
  }),

  'game.action.concede.json': c => cmd.gameAction(c, { gameId: 'g1', action: { kind: 'concede' } }),
  'game.action.skip.json': c => cmd.gameAction(c, { gameId: 'g1', action: { kind: 'skip', mode: 'endOfTurn' } }),
  'game.action.rollback.json': c => cmd.gameAction(c, { gameId: 'g1', action: { kind: 'requestRollback', turns: 1 } }),
  'game.action.autoMana.json': c => cmd.gameAction(c, { gameId: 'g1', action: { kind: 'autoMana', enabled: false } }),
  'game.action.triggerOrder.json': c => cmd.gameAction(c, { gameId: 'g1', action: { kind: 'triggerOrder', mode: 'reset' } }),
};

describe('conformance corpus', () => {
  it('holds the complete 47-sample set', () => {
    expect(files.length).toBe(47);
  });

  it('covers every sample in exactly one direction', () => {
    for (const f of files) {
      const parsed = JSON.parse(fs.readFileSync(path.join(samplesDir, f), 'utf8')) as { t: string };
      const isServer = SERVER_TYPES.has(parsed.t);
      const hasBuilder = Object.hasOwn(builders, f);
      expect(isServer !== hasBuilder, `${f} (t=${parsed.t}) must be either decoded or reproduced`).toBe(true);
    }
    // no builder entries for files that don't exist
    for (const name of Object.keys(builders)) expect(files).toContain(name);
  });

  for (const f of files) {
    const text = fs.readFileSync(path.join(samplesDir, f), 'utf8');
    const parsed = JSON.parse(text) as Record<string, unknown> & { t: string; id?: string };

    if (SERVER_TYPES.has(parsed.t)) {
      it(`decodes ${f} (dev-strict)`, () => {
        const r = decode(text, { strict: true });
        expect(r.ok, r.ok ? '' : r.error).toBe(true);
        if (r.ok) {
          expect(r.msg).not.toBeNull();
          expect(r.msg?.t).toBe(parsed.t);
        }
        // and the prod-lenient path accepts it too
        const lenient = decode(text, { strict: false });
        expect(lenient.ok && lenient.msg !== null).toBe(true);
      });
    } else if (Object.hasOwn(builders, f)) {
      it(`reproduces ${f} through the builders`, () => {
        expect(typeof parsed.id).toBe('string');
        const ctx: CommandContext = { mintId: () => parsed.id as string, now: () => 0 };
        const built = builders[f]!(ctx);
        expect(JSON.parse(encode(built))).toEqual(parsed);
      });
    }
  }
});
