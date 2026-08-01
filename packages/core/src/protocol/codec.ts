// decode()/encode() for protocol v1 (docs/protocol/v1.md).
//
// Hand-rolled per-type narrowing (design §1): a schema library would be a second
// transcription of v1.md that can drift from the first; the conformance corpus is
// the real guard. Policy (design §1, protocol §3):
//   strict  (dev/test)  — unknown `t`, unknown fields, and out-of-vocabulary enum
//                         strings are all errors; a sample that trips this is a spec bug.
//   lenient (prod)      — unknown `t` and unknown fields are ignored (forward
//                         compatibility); string enums accept new values. Wrong-typed
//                         known fields still fail — leniency is forward-compat,
//                         not garbage tolerance.
// Non-string literals (v:1, canPass:true, finalState:true) are shape markers and are
// checked in both modes. Prompt kinds are frozen within a major (protocol §13), so an
// unknown kind fails in both modes; the error message carries the kind so the C3
// prompt UI can render its visible failure card from it.

import type { ClientMsg, ServerMsg } from './protocol';

export interface DecodeOptions { strict?: boolean }

export type DecodeResult =
  | { ok: true; msg: ServerMsg }
  | { ok: true; msg: null; ignoredType: string }   // lenient only: unknown `t`, ignored
  | { ok: false; error: string };

export function encode(msg: ClientMsg): string {
  return JSON.stringify(msg);
}

export function decode(raw: string | unknown, opts: DecodeOptions = {}): DecodeResult {
  const ctx: Ctx = { strict: opts.strict ?? false };
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: `unparseable frame: ${(e as Error).message}` };
    }
  }
  if (!isPlainObject(v)) return { ok: false, error: `expected a JSON object frame, got ${typeName(v)}` };
  const t = v['t'];
  if (typeof t !== 'string') return { ok: false, error: "missing 't' discriminator" };
  const check = serverChecks[t];
  if (!check) {
    if (ctx.strict) return { ok: false, error: `unknown message type '${t}' (strict mode)` };
    return { ok: true, msg: null, ignoredType: t };
  }
  try {
    check(v, t, ctx);
  } catch (e) {
    if (e instanceof Mismatch) return { ok: false, error: e.message };
    throw e;
  }
  return { ok: true, msg: v as unknown as ServerMsg };
}

// ── validation combinators ───────────────────────────────────────────────────

class Mismatch extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
  }
}

interface Ctx { strict: boolean }
type Check = (v: unknown, path: string, ctx: Ctx) => void;

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Explicit type annotation required: TS only honors never-return control-flow
// narrowing for explicitly-typed callees.
const fail: (path: string, detail: string) => never = (path, detail) => {
  throw new Mismatch(path, detail);
};

const str: Check = (v, p) => {
  if (typeof v !== 'string') fail(p, `expected string, got ${typeName(v)}`);
};
const num: Check = (v, p) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(p, `expected number, got ${typeName(v)}`);
};
const bool: Check = (v, p) => {
  if (typeof v !== 'boolean') fail(p, `expected boolean, got ${typeName(v)}`);
};
const any: Check = () => {};

// exact literal(s) — enforced in both modes (shape markers like v:1, canPass:true)
const lit = (...allowed: readonly (string | number | boolean)[]): Check => (v, p) => {
  if (!allowed.includes(v as string | number | boolean))
    fail(p, `expected ${allowed.map(a => JSON.stringify(a)).join('|')}, got ${JSON.stringify(v)}`);
};

// string vocabulary — enforced strictly in dev/test; any string passes in prod
// (within a major, additions are allowed for open sets like error codes)
const strEnum = (...allowed: readonly string[]): Check => (v, p, c) => {
  if (typeof v !== 'string') fail(p, `expected string, got ${typeName(v)}`);
  if (c.strict && !allowed.includes(v))
    fail(p, `'${v}' not in vocabulary [${allowed.join(', ')}] (strict mode)`);
};

const arr = (item: Check): Check => (v, p, c) => {
  if (!Array.isArray(v)) fail(p, `expected array, got ${typeName(v)}`);
  (v as unknown[]).forEach((x, i) => item(x, `${p}[${i}]`, c));
};

const tuple2 = (a: Check, b: Check): Check => (v, p, c) => {
  if (!Array.isArray(v) || v.length !== 2) fail(p, `expected 2-tuple, got ${typeName(v)}`);
  const [x, y] = v as [unknown, unknown];
  a(x, `${p}[0]`, c);
  b(y, `${p}[1]`, c);
};

const record = (value: Check): Check => (v, p, c) => {
  if (!isPlainObject(v)) fail(p, `expected object, got ${typeName(v)}`);
  for (const [k, x] of Object.entries(v)) value(x, `${p}.${k}`, c);
};

interface Shape { req: Record<string, Check>; opt?: Record<string, Check> }

const obj = ({ req, opt = {} }: Shape): Check => (v, p, c) => {
  if (!isPlainObject(v)) fail(p, `expected object, got ${typeName(v)}`);
  for (const [k, check] of Object.entries(req)) {
    if (!Object.hasOwn(v, k) || v[k] === undefined) fail(`${p}.${k}`, 'missing required field');
    check(v[k], `${p}.${k}`, c);
  }
  for (const [k, check] of Object.entries(opt)) {
    if (Object.hasOwn(v, k) && v[k] !== undefined) check(v[k], `${p}.${k}`, c);
  }
  if (c.strict) {
    for (const k of Object.keys(v)) {
      if (!Object.hasOwn(req, k) && !Object.hasOwn(opt, k))
        fail(`${p}.${k}`, 'unknown field (strict mode)');
    }
  }
};

// ── §6 game state shapes ─────────────────────────────────────────────────────

const idc = str;
const colorC = strEnum('W', 'U', 'B', 'R', 'G');
const counterC = obj({ req: { name: str, count: num } });

const cardShape: Shape = {
  req: {
    id: idc, name: str, set: str, number: str, manaValue: num,
    types: arr(str), subtypes: arr(str), supertypes: arr(str),
    colors: arr(colorC), text: arr(str),
  },
  opt: {
    manaCost: str, power: str, toughness: str, loyalty: str, defense: str,
    counters: arr(counterC), token: bool, imageNumber: num, faceDown: bool,
    ability: bool,
  },
};
const cardC = obj(cardShape);

const permanentC = obj({
  req: { ...cardShape.req, controllerId: idc, tapped: bool },
  opt: {
    ...cardShape.opt,
    flipped: bool, transformed: bool,
    morph: strEnum('morphed', 'manifested', 'disguised', 'cloaked'),
    damage: num, summoningSick: bool,
    attachments: arr(idc), attachedTo: idc, copy: bool, commander: bool,
  },
});

const commandObjectC = obj({
  req: { ...cardShape.req, kind: strEnum('commander', 'emblem', 'plane', 'dungeon') },
  opt: { ...cardShape.opt, castCount: num },
});

const stackItemC = obj({
  req: { id: idc, kind: strEnum('spell', 'ability'), text: arr(str) },
  opt: { controllerId: idc, card: cardC, targets: arr(idc) },
});

const playerC = obj({
  req: {
    id: idc, name: str, human: bool, life: num,
    manaPool: obj({ req: { W: num, U: num, B: num, R: num, G: num, C: num } }),
    librarySize: num, handSize: num,
    battlefield: arr(permanentC), graveyard: arr(cardC), exile: arr(cardC),
    commandZone: arr(commandObjectC),
  },
  opt: {
    counters: arr(counterC),
    commanderDamage: arr(obj({ req: { fromCommanderId: idc, amount: num } })),
    flags: obj({ req: {}, opt: { monarch: bool, initiative: bool, left: bool, dead: bool } }),
    timer: obj({ req: { remainingSecs: num, active: bool } }),
    topCard: cardC,   // library top while revealed (Future Sight-class, §6)
  },
});

const revealWindowC = obj({ req: { name: str, cards: arr(cardC) } });

const gameStateC = obj({
  req: {
    gameId: idc,
    status: strEnum('active', 'over'),
    rollbackTurnsAllowed: bool,
    // phase/step/activePlayerId absent during the pre-game mulligan window (§6)
    turn: obj({
      req: { n: num },
      opt: {
        phase: strEnum('BEGINNING', 'PRECOMBAT_MAIN', 'COMBAT', 'POSTCOMBAT_MAIN', 'END'),
        step: strEnum('UNTAP', 'UPKEEP', 'DRAW', 'PRE_MAIN', 'BEGIN_COMBAT', 'DECLARE_ATTACKERS',
                      'DECLARE_BLOCKERS', 'FIRST_COMBAT_DAMAGE', 'COMBAT_DAMAGE', 'END_COMBAT',
                      'POST_MAIN', 'END_TURN', 'CLEANUP'),
        activePlayerId: idc,
        priorityPlayerId: idc,
      },
    }),
    players: arr(playerC),
    stack: arr(stackItemC),
    me: obj({
      req: { playerId: idc, hand: arr(cardC) },
      opt: { skip: strEnum('stack', 'endOfTurn', 'nextMain', 'myNextTurn', 'endStepBeforeMyTurn') },
    }),
  },
  opt: {
    combat: arr(obj({ req: { attackerIds: arr(idc), defenderId: idc, blockerIds: arr(idc), blocked: bool } })),
    revealed: arr(revealWindowC),
    lookedAt: arr(revealWindowC),
  },
});

// ── §7 patches ───────────────────────────────────────────────────────────────

const addOrReplaceC = obj({ req: { op: lit('add', 'replace'), path: str, value: any } });
const removeC = obj({ req: { op: lit('remove'), path: str } });
const patchOpC: Check = (v, p, c) => {
  if (!isPlainObject(v)) fail(p, `expected patch op object, got ${typeName(v)}`);
  const op = v['op'];
  if (op === 'add' || op === 'replace') addOrReplaceC(v, p, c);
  else if (op === 'remove') removeC(v, p, c);
  else fail(`${p}.op`, `expected "add"|"remove"|"replace", got ${JSON.stringify(op)}`);
};

// ── §7.1 semantic events (advisory) ──────────────────────────────────────────

const phaseC = strEnum('BEGINNING', 'PRECOMBAT_MAIN', 'COMBAT', 'POSTCOMBAT_MAIN', 'END');
const stepC = strEnum('UNTAP', 'UPKEEP', 'DRAW', 'PRE_MAIN', 'BEGIN_COMBAT', 'DECLARE_ATTACKERS',
                      'DECLARE_BLOCKERS', 'FIRST_COMBAT_DAMAGE', 'COMBAT_DAMAGE', 'END_COMBAT',
                      'POST_MAIN', 'END_TURN', 'CLEANUP');
const zoneC = strEnum('hand', 'battlefield', 'graveyard', 'exile', 'library', 'stack', 'command');
const verbC = strEnum('cast', 'play', 'resolve', 'counter', 'destroy', 'sacrifice', 'exile', 'discard',
                      'mill', 'bounce', 'draw', 'tutor', 'put', 'token', 'attach', 'detach');
const causeC = obj({ req: {}, opt: { objectId: idc, name: str, playerId: idc } });

// Every §7.1 kind (mirrors the bridge's GameEvent `permits`): the M6 zone-motion
// core + step, plus the T4 choreography kinds.
const eventKindChecks: Record<string, Check> = {
  move: obj({
    req: { k: lit('move'), objectId: idc, from: zoneC, to: zoneC, verb: verbC },
    opt: { cause: causeC, reason: str },
  }),
  hidden: obj({
    req: { k: lit('hidden'), playerId: idc, from: zoneC, to: zoneC, count: num, verb: verbC },
  }),
  stackLink: obj({ req: { k: lit('stackLink'), stackId: idc, objectId: idc } }),
  tap: obj({ req: { k: lit('tap'), objectId: idc }, opt: { forMana: bool } }),
  untap: obj({ req: { k: lit('untap'), objectId: idc }, opt: { forMana: bool } }),
  attack: obj({ req: { k: lit('attack'), attackerIds: arr(idc), defenderId: idc } }),
  block: obj({ req: { k: lit('block'), attackerId: idc, blockerIds: arr(idc) } }),
  damage: obj({
    req: { k: lit('damage'), targetId: idc, amount: num, combat: bool },
    opt: { cause: causeC },
  }),
  life: obj({
    req: { k: lit('life'), playerId: idc, from: num, to: num },
    opt: { cause: causeC },
  }),
  counters: obj({ req: { k: lit('counters'), objectId: idc, name: str, from: num, to: num } }),
  trigger: obj({ req: { k: lit('trigger'), sourceId: idc }, opt: { stackId: idc } }),
  reveal: obj({ req: { k: lit('reveal'), objectIds: arr(idc) }, opt: { playerId: idc } }),
  shuffle: obj({ req: { k: lit('shuffle'), playerId: idc } }),
  scry: obj({ req: { k: lit('scry'), playerId: idc } }),
  search: obj({ req: { k: lit('search'), playerId: idc } }),
  step: obj({ req: { k: lit('step') }, opt: { phase: phaseC, step: stepC, activePlayerId: idc } }),
};

// Events are advisory (§7.1): unlike prompt kinds (frozen, unknown = error), an
// unknown event `k` is *ignored* even in strict mode — a client degrades to
// teleport rendering. Known kinds are shape-checked so real drift still trips.
const eventC: Check = (v, p, c) => {
  if (!isPlainObject(v)) fail(p, `expected event object, got ${typeName(v)}`);
  const k = v['k'];
  if (typeof k !== 'string') fail(`${p}.k`, 'missing event kind');
  const check = eventKindChecks[k];
  if (check) check(v, p, c);   // unknown k: accepted opaquely (forward-compat)
};

// ── §8 prompts ───────────────────────────────────────────────────────────────

const promptBaseReq: Record<string, Check> = {
  t: lit('game.prompt'), seq: num, gameId: idc, promptId: num, message: str,
};

const keyTextC = obj({ req: { key: str, text: str } });

const promptKindChecks: Record<string, Check> = {
  confirm: obj({
    req: { ...promptBaseReq, kind: lit('confirm') },
    opt: { yesText: str, noText: str },
  }),
  priority: obj({
    req: {
      ...promptBaseReq, kind: lit('priority'),
      playable: record(arr(obj({ req: { kind: strEnum('mana', 'play', 'cast', 'ability'), text: str } }))),
      canPass: lit(true),
    },
    opt: {
      combat: obj({
        req: { role: strEnum('attackers', 'blockers'), candidates: arr(idc), declared: arr(idc) },
        opt: { special: str },
      }),
    },
  }),
  chooseTargets: obj({
    req: { ...promptBaseReq, kind: lit('chooseTargets'), candidates: arr(idc), min: num, max: num, required: bool },
    opt: { zone: str, progress: obj({ req: { chosen: num, of: num } }), cards: arr(cardC) },
  }),
  chooseAbility: obj({
    req: { ...promptBaseReq, kind: lit('chooseAbility'), options: arr(obj({ req: { id: idc, text: str } })) },
    opt: { sourceId: idc },
  }),
  chooseOption: obj({
    req: { ...promptBaseReq, kind: lit('chooseOption'), options: arr(keyTextC) },
    opt: { required: bool },
  }),
  choosePile: obj({
    req: { ...promptBaseReq, kind: lit('choosePile'), piles: tuple2(arr(cardC), arr(cardC)) },
  }),
  payMana: obj({
    req: { ...promptBaseReq, kind: lit('payMana'), remaining: str, canCancel: bool },
    opt: { sources: arr(idc), for: idc },
  }),
  chooseAmount: obj({
    req: { ...promptBaseReq, kind: lit('chooseAmount'), min: num, max: num },
  }),
  distribute: obj({
    req: {
      ...promptBaseReq, kind: lit('distribute'), total: num, min: num,
      among: arr(obj({
        req: { id: idc, label: str },
        opt: { min: num, max: num, suggested: num, objectId: idc },
      })),
    },
    opt: { canCancel: bool },
  }),
  playerRequest: obj({
    req: { ...promptBaseReq, kind: lit('playerRequest'), requestKey: str, options: arr(keyTextC) },
  }),
};

const promptC: Check = (v, p, c) => {
  if (!isPlainObject(v)) fail(p, `expected object, got ${typeName(v)}`);
  const kind = v['kind'];
  if (typeof kind !== 'string') fail(`${p}.kind`, 'missing prompt kind');
  const check = promptKindChecks[kind as string];
  // Prompt kinds are frozen within a major (protocol §13): unknown kind is an
  // error in both modes, never silently ignored — the UI renders a failure card.
  if (!check) fail(`${p}.kind`, `unknown prompt kind '${kind as string}'`);
  else check(v, p, c);
};

// ── §3/§4/§5/§10/§11/§12 top-level server messages ───────────────────────────

const errorCodeC = strEnum(
  'UNSUPPORTED_VERSION', 'AUTH_FAILED', 'RESUME_FAILED',
  'BAD_MESSAGE', 'UNKNOWN_GAME',
  'PROMPT_STALE', 'INVALID_ANSWER',
  'DECK_INVALID', 'LOBBY_STATE',
  'UPSTREAM_ERROR',
);

const seatC = obj({
  req: {
    userId: idc, name: str, ready: bool,
  },
  opt: {
    deck: obj({
      req: { valid: bool, cards: num },
      opt: {
        commander: arr(str), format: strEnum('dck', 'moxfield', 'mtgo'),
        problems: arr(str), warnings: arr(str),
      },
    }),
  },
});

const serverChecks: Record<string, Check> = {
  'ack': obj({ req: { t: lit('ack'), re: str } }),
  'error': obj({
    req: { t: lit('error'), code: errorCodeC, message: str },
    opt: { re: str, fatal: bool },
  }),
  'session.welcome': obj({
    req: { t: lit('session.welcome'), re: str, v: lit(1), userId: idc, role: strEnum('player', 'spectator'), resumed: bool },
    opt: { token: str },
  }),
  'lobby.state': obj({
    req: { t: lit('lobby.state'), code: str, hostUserId: idc, seats: arr(seatC) },
  }),
  'game.state': obj({
    req: { t: lit('game.state'), seq: num, gameId: idc, state: gameStateC },
    opt: { events: arr(eventC) },
  }),
  'game.patch': obj({
    req: { t: lit('game.patch'), seq: num, gameId: idc, base: num, ops: arr(patchOpC) },
    opt: { events: arr(eventC) },
  }),
  'game.prompt': promptC,
  'game.promptDone': obj({
    req: { t: lit('game.promptDone'), seq: num, gameId: idc, promptId: num, reason: strEnum('answered', 'superseded', 'gameOver') },
  }),
  'game.log': obj({
    req: { t: lit('game.log'), seq: num, gameId: idc, ts: num, kind: strEnum('game', 'chat', 'status', 'error', 'personal'), text: str },
    opt: { turn: str, refs: arr(obj({ req: { objectId: idc, name: str } })), playerId: idc },
  }),
  'game.over': obj({
    req: { t: lit('game.over'), seq: num, gameId: idc, winnerPlayerIds: arr(idc), reason: str, finalState: lit(true) },
  }),
};
