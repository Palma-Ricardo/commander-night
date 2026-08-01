// Codec policy tests (design §1): dev-strict vs prod-lenient behavior beyond
// what the corpus samples exercise.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decode } from '../src/protocol/codec';

const stateSample = fs.readFileSync(
  fileURLToPath(new URL('../../../docs/protocol/samples/game.state.json', import.meta.url)), 'utf8');

describe('decode envelope policy', () => {
  it('rejects unparseable frames in both modes', () => {
    for (const strict of [true, false]) {
      const r = decode('not json', { strict });
      expect(r.ok).toBe(false);
    }
  });

  it('rejects non-object frames and missing t', () => {
    expect(decode('42').ok).toBe(false);
    expect(decode('{"seq":1}').ok).toBe(false);
  });

  it('ignores unknown t in lenient mode, rejects it in strict', () => {
    const frame = '{"t":"game.confetti","seq":9}';
    const lenient = decode(frame, { strict: false });
    expect(lenient.ok && lenient.msg === null && lenient.ignoredType === 'game.confetti').toBe(true);
    expect(decode(frame, { strict: true }).ok).toBe(false);
  });

  it('ignores unknown fields in lenient mode, rejects them in strict', () => {
    const frame = '{"t":"ack","re":"c1","shiny":true}';
    const lenient = decode(frame, { strict: false });
    expect(lenient.ok && lenient.msg !== null).toBe(true);
    const strict = decode(frame, { strict: true });
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.error).toContain('shiny');
  });

  it('rejects wrong-typed known fields even in lenient mode', () => {
    expect(decode('{"t":"ack","re":42}', { strict: false }).ok).toBe(false);
    expect(decode('{"t":"game.patch","seq":1,"gameId":"g1","base":"x","ops":[]}', { strict: false }).ok).toBe(false);
  });

  it('rejects missing required fields with the field path', () => {
    const r = decode('{"t":"game.promptDone","seq":1,"gameId":"g1"}', { strict: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('promptId');
  });
});

describe('vocabulary policy', () => {
  it('accepts a new error code leniently, rejects it strictly (additive within a major)', () => {
    const frame = '{"t":"error","code":"FUTURE_CODE","message":"?"}';
    expect(decode(frame, { strict: false }).ok).toBe(true);
    expect(decode(frame, { strict: true }).ok).toBe(false);
  });

  it('rejects an unknown prompt kind in BOTH modes (kinds are frozen within a major, §13)', () => {
    const frame = '{"t":"game.prompt","seq":1,"gameId":"g1","promptId":7,"message":"?","kind":"juggle"}';
    for (const strict of [true, false]) {
      const r = decode(frame, { strict });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('juggle');
    }
  });

  it('checks shape-marker literals (v, canPass, finalState) in both modes', () => {
    const welcome = '{"t":"session.welcome","re":"c1","v":2,"userId":"u1","role":"player","resumed":false}';
    expect(decode(welcome, { strict: false }).ok).toBe(false);
    const over = '{"t":"game.over","seq":1,"gameId":"g1","winnerPlayerIds":[],"reason":"?","finalState":false}';
    expect(decode(over, { strict: false }).ok).toBe(false);
  });

  it('rejects a patch op outside add/remove/replace', () => {
    const frame = '{"t":"game.patch","seq":2,"gameId":"g1","base":1,"ops":[{"op":"move","from":"/a","path":"/b"}]}';
    expect(decode(frame, { strict: false }).ok).toBe(false);
  });
});

describe('deep GameState validation', () => {
  it('narrows the keyframe sample to typed state', () => {
    const r = decode(stateSample, { strict: true });
    expect(r.ok).toBe(true);
    if (!r.ok || r.msg === null) throw new Error('unreachable');
    const msg = r.msg;
    if (msg.t !== 'game.state') throw new Error('wrong type');
    expect(msg.state.players[0]?.battlefield[0]?.tapped).toBe(true);
    expect(msg.state.me.skip).toBe('stack');
    expect(msg.state.players[1]?.commanderDamage?.[0]?.amount).toBe(5);
    expect(msg.state.stack[0]?.targets).toEqual(['perm-1']);
  });

  it('accepts imageNumber on token cards in strict mode (§6 tokens-only art discriminator)', () => {
    // Regression guard. Live 2026-07-23 a token copy on the stack carried
    // imageNumber (XMage TokenInfo.imageNumber, set by ViewTranslator for tokens);
    // the type + spec both define the field but cardShape.opt omitted it, so
    // dev-strict decode rejected `stack[2].card.imageNumber` as unknown — dropping
    // the keyframe and forcing a resync. Cover both the stack path (the exact live
    // site) and a battlefield permanent (Permanent inherits the card shape).
    const doctored = JSON.parse(stateSample) as {
      state: {
        players: { battlefield: Record<string, unknown>[] }[];
        stack: { card: Record<string, unknown> }[];
      };
    };
    doctored.state.stack[0]!.card!.token = true;
    doctored.state.stack[0]!.card!.imageNumber = 3;
    doctored.state.players[0]!.battlefield[0]!.token = true;
    doctored.state.players[0]!.battlefield[0]!.imageNumber = 0;

    const r = decode(doctored, { strict: true });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok || r.msg === null) throw new Error('unreachable');
    if (r.msg.t !== 'game.state') throw new Error('wrong type');
    expect(r.msg.state.stack[0]?.card?.imageNumber).toBe(3);
    expect(r.msg.state.players[0]?.battlefield[0]?.imageNumber).toBe(0);
  });

  it('accepts commander on a battlefield permanent in strict mode (§6)', () => {
    // The bridge flags a commander in play from XMage's own card icon (added
    // 2026-08-01) — the only wire signal for it, since the command zone empties
    // when the commander is cast. Dev-strict rejects unknown fields, so the
    // decoder has to carry it or a keyframe with a cast commander is dropped.
    const doctored = JSON.parse(stateSample) as {
      state: { players: { battlefield: Record<string, unknown>[] }[] };
    };
    doctored.state.players[0]!.battlefield[0]!.commander = true;

    const r = decode(doctored, { strict: true });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok || r.msg === null) throw new Error('unreachable');
    if (r.msg.t !== 'game.state') throw new Error('wrong type');
    expect(r.msg.state.players[0]?.battlefield[0]?.commander).toBe(true);
  });

  it('accepts ability on a chooseTargets card in strict mode (§7 trigger-order picker)', () => {
    // Regression guard. Live 2026-07-23: a trigger-order picker (Lattice Library's
    // ETB) arrives as a chooseTargets whose cards carry `ability:true` (the source
    // card's printing + that one ability's rule). The type + spec define the field
    // but cardShape.opt omitted it, so dev-strict decode rejected `cards[0].ability`
    // as unknown — silently dropping the whole prompt, no modal, wedging the game on
    // XMage's waitForResponse. Both a card in a prompt grid and (below) any card path.
    const frame = JSON.stringify({
      t: 'game.prompt', seq: 1, gameId: 'g1', promptId: 9, message: 'Pick triggered ability',
      kind: 'chooseTargets', candidates: ['ab-1'], min: 1, max: 1, required: true,
      cards: [{
        id: 'ab-1', name: 'Chishiro, the Shattered Blade', set: 'NEO', number: '215', manaValue: 3,
        types: ['CREATURE'], subtypes: ['Snake', 'Warrior'], supertypes: ['Legendary'],
        colors: ['R', 'G'], text: ['Whenever an Aura or Equipment you control enters, …'],
        ability: true,
      }],
    });
    const r = decode(frame, { strict: true });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok || r.msg === null) throw new Error('unreachable');
    if (r.msg.t !== 'game.prompt' || r.msg.kind !== 'chooseTargets') throw new Error('wrong type');
    expect(r.msg.cards?.[0]?.ability).toBe(true);
  });

  it('flags an unknown field nested deep in a player (strict), passes it leniently', () => {
    const doctored = JSON.parse(stateSample) as {
      state: { players: Record<string, unknown>[] };
    };
    doctored.state.players[0]!['favoriteSnack'] = 'olives';
    const strict = decode(doctored, { strict: true });
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.error).toContain('favoriteSnack');
    expect(decode(doctored, { strict: false }).ok).toBe(true);
  });

  it('flags a wrong-typed field nested deep in a permanent in both modes', () => {
    const doctored = JSON.parse(stateSample) as {
      state: { players: { battlefield: { tapped: unknown }[] }[] };
    };
    doctored.state.players[0]!.battlefield[0]!.tapped = 'yes';
    expect(decode(doctored, { strict: true }).ok).toBe(false);
    expect(decode(doctored, { strict: false }).ok).toBe(false);
  });
});
