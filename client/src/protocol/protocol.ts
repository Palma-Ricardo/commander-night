// Commander Night — protocol v1 types.
//
// Transcribed from docs/protocol/v1.md (normative). Wire changes happen there first,
// then here — never the other way around. Section markers below cite v1.md.
// The conformance corpus (docs/protocol/samples) pins both codebases to these shapes.

// ── §3 Transport and envelope ────────────────────────────────────────────────

export type Id = string;

export interface Command { t: string; id: string }          // client → server
export interface Event   { t: string; seq?: number }        // server → client
export interface Ack     { t: 'ack';   re: string }
export interface Err     { t: 'error'; re?: string; code: ErrorCode; message: string; fatal?: boolean }

// ── §4 Session layer ─────────────────────────────────────────────────────────

// client → server, first message on every connection
export interface Hello {
  t: 'session.hello';
  id: string;
  v: 1;                       // protocol major version; server rejects mismatch
  token?: string;             // session token from a prior welcome (§16.6); omit on first connect
  resume?: { gameId: Id; lastSeq: number };
  stateMode?: 'keyframes';    // §7 debug escape hatch: full keyframes instead of patches
}

// server → client
export interface Welcome {
  t: 'session.welcome';
  re: string;
  v: 1;
  userId: Id;
  token?: string;             // fresh sessions only: bridge-minted session token — persist
                              // (localStorage) and present on every later hello (§16.6)
  role: 'player' | 'spectator';
  resumed: boolean;           // true → keyframe + open prompt follow immediately
}

// ── §5 Lobby layer ───────────────────────────────────────────────────────────

export interface LobbyCreate extends Command { t: 'lobby.create'; format: 'commander-ffa'; name?: string }
export interface LobbyJoin   extends Command { t: 'lobby.join';   code: string; displayName: string }
export interface LobbyDeck   extends Command { t: 'lobby.deck';   format: 'dck' | 'list'; content: string }
export interface LobbyReady  extends Command { t: 'lobby.ready';  ready: boolean }
export interface LobbyStart  extends Command { t: 'lobby.start';  fillAI?: boolean }

// event — full small snapshot on every change (no diffing needed at this size)
export interface LobbyState {
  t: 'lobby.state';
  code: string;
  hostUserId: Id;
  seats: { userId: Id; name: string; deck?: { valid: boolean; commander?: string[];
           cards: number; problems?: string[] }; ready: boolean }[];
}

// ── §6 Game state model ──────────────────────────────────────────────────────

export type Color = 'W'|'U'|'B'|'R'|'G';
export type Phase = 'BEGINNING'|'PRECOMBAT_MAIN'|'COMBAT'|'POSTCOMBAT_MAIN'|'END';
export type Step  = 'UNTAP'|'UPKEEP'|'DRAW'|'PRE_MAIN'|'BEGIN_COMBAT'|'DECLARE_ATTACKERS'
                  | 'DECLARE_BLOCKERS'|'FIRST_COMBAT_DAMAGE'|'COMBAT_DAMAGE'|'END_COMBAT'
                  | 'POST_MAIN'|'END_TURN'|'CLEANUP';

export interface Card {
  id: Id;
  name: string;
  set: string;                 // expansion set code
  number: string;              // collector number  → set+number = image lookup key
  manaCost?: string;           // "{2}{U}{U}"
  manaValue: number;
  types: string[];             // CREATURE, INSTANT, …
  subtypes: string[];
  supertypes: string[];
  colors: Color[];
  text: string[];              // rules lines, XMage HTML stripped to plain text
  power?: string; toughness?: string;
  loyalty?: string; defense?: string;
  counters?: { name: string; count: number }[];
  token?: boolean;
  faceDown?: boolean;          // face-down anywhere (exile, library plays, …)
}

export interface Permanent extends Card {
  controllerId: Id;
  tapped: boolean;
  flipped?: boolean;
  transformed?: boolean;
  // The controller's view of their own face-down permanent keeps its identity;
  // opponents receive a server-redacted 2/2 — privacy is XMage's job, not ours.
  morph?: 'morphed'|'manifested'|'disguised'|'cloaked';
  damage?: number;
  summoningSick?: boolean;
  attachments?: Id[];          // auras/equipment attached to this
  attachedTo?: Id;             // permanent or player this is attached to
  copy?: boolean;
}

export interface StackItem {
  id: Id;
  controllerId?: Id;           // absent when XMage's view doesn't expose it (§6)
  kind: 'spell' | 'ability';
  card?: Card;                 // the spell, or the ability's source card for context
  text: string[];              // what will happen (ability rules text)
  targets?: Id[];              // chosen targets (object or player ids)
}

export interface CommandObject extends Card {
  kind: 'commander' | 'emblem' | 'plane' | 'dungeon';
  castCount?: number;          // commander tax = 2 × castCount
}

export interface Player {
  id: Id;
  name: string;
  human: boolean;
  life: number;
  counters?: { name: string; count: number }[];   // poison, energy, experience, …
  manaPool: { W:number; U:number; B:number; R:number; G:number; C:number };
  librarySize: number;
  handSize: number;
  battlefield: Permanent[];
  graveyard: Card[];           // ordered, newest last
  exile: Card[];
  commandZone: CommandObject[];
  commanderDamage?: { fromCommanderId: Id; amount: number }[];
  flags?: { monarch?: boolean; initiative?: boolean; left?: boolean; dead?: boolean };
  timer?: { remainingSecs: number; active: boolean };   // absent when clocks disabled
}

export interface CombatGroup {
  attackerIds: Id[];
  defenderId: Id;              // player, planeswalker, or battle
  blockerIds: Id[];
  blocked: boolean;
}

export interface GameState {
  gameId: Id;
  status: 'active' | 'over';
  rollbackTurnsAllowed: boolean;   // table option, constant for a game; gates
                                   // game.action requestRollback (§9)
  turn: {
    n: number;
    phase: Phase;
    step: Step;
    activePlayerId: Id;
    priorityPlayerId?: Id;
  };
  players: Player[];           // seat order; includes me
  stack: StackItem[];          // bottom → top
  combat?: CombatGroup[];
  revealed?: { name: string; cards: Card[] }[];   // shared reveal windows
  lookedAt?: { name: string; cards: Card[] }[];   // private to this seat
  me: {                                           // private zone; spectators: omitted
    playerId: Id;
    hand: Card[];
    // The active §9 skip; absent = none. At most one is ever active (1.4.60
    // PlayerImpl resets every skip flag before setting any). Cleared server-side
    // as a normal patch; skip:'stack' on an empty stack is an XMage no-op.
    skip?: 'stack'|'endOfTurn'|'nextMain'|'myNextTurn'|'endStepBeforeMyTurn';
  };
}

// ── §7 State synchronisation: keyframe + patch ───────────────────────────────

export type JsonPatchOp =                       // RFC 6902, restricted per bridge §1
  | { op: 'add';     path: string; value: unknown }
  | { op: 'remove';  path: string }
  | { op: 'replace'; path: string; value: unknown };

export interface StateKeyframe { t:'game.state'; seq: number; gameId: Id; state: GameState }
export interface StatePatch    { t:'game.patch'; seq: number; gameId: Id;
                                 base: number;                  // seq the ops apply to
                                 ops: JsonPatchOp[] }           // paths into GameState
export interface Resync        { t:'game.resync'; id: string; gameId: Id }   // client → server

// ── §8 Prompts (server asks) and answers ─────────────────────────────────────

export interface PromptBase { t:'game.prompt'; seq: number; gameId: Id;
                              promptId: number; message: string }

export type Prompt = PromptBase & (
  // GAME_ASK — yes/no
  | { kind:'confirm'; yesText?: string; noText?: string }

  // GAME_SELECT — you have priority, or a combat declaration (see `combat`).
  // `playable` is always {} when `combat` is present; combat toggles are one per
  // round trip and `{type:'objects'}` is rejected there (v1.md §8).
  | { kind:'priority';
      playable: Record<Id, { kind:'mana'|'play'|'cast'|'ability'; text: string }[]>;
      canPass: true;
      combat?: { role:'attackers'|'blockers';
                 candidates: Id[];      // may be toggled into combat
                 declared: Id[];        // yours already in combat (toggle out)
                 special?: string } }   // shortcut button label, e.g. "All attack"

  // GAME_TARGET / GAME_SELECT with targets — pick objects/players.
  | { kind:'chooseTargets'; candidates: Id[]; min: number; max: number;
      required: boolean; zone?: string;
      progress?: { chosen: number; of: number };
      cards?: Card[] }        // full views when candidates aren't in visible state

  // GAME_CHOOSE_ABILITY — which ability/mode of a source
  | { kind:'chooseAbility'; sourceId?: Id; options: { id: Id; text: string }[] }

  // GAME_CHOOSE_CHOICE — pick one string option (modes, colors, …).
  // `required:false` means the choice may be declined with {type:'cancel'}.
  | { kind:'chooseOption'; options: { key: string; text: string }[]; required?: boolean }

  // GAME_CHOOSE_PILE — either pile may be empty
  | { kind:'choosePile'; piles: [Card[], Card[]] }

  // GAME_PLAY_MANA — pay a cost. A source click may NOT progress payment
  // (progress ⇔ the remaining cost in the re-ask shrank).
  | { kind:'payMana'; remaining: string;          // e.g. "{1}{U}", "{1}{B/P}{B/P}"
      sources?: Id[]; canCancel: boolean }

  // GAME_GET_AMOUNT — announce X / pick a number. The answer is required:
  // {type:'cancel'} is rejected with INVALID_ANSWER.
  | { kind:'chooseAmount'; min: number; max: number }

  // GAME_GET_MULTI_AMOUNT — split a total across rows. Row `id` is a
  // bridge-synthesized index ("0", "1", …), valid only within this prompt.
  // Constraint: min ≤ Σ amounts ≤ total, each row inside its own [min, max].
  | { kind:'distribute'; total: number; min: number;
      among: { id: Id; label: string;
               min?: number; max?: number;      // per-row bounds when XMage sends them
               suggested?: number }[];          // XMage's default split
      canCancel?: boolean }

  // USER_REQUEST_DIALOG — meta requests (rollback permission, …). Option keys are
  // XMage PlayerAction enum names, or "dismiss".
  | { kind:'playerRequest'; requestKey: string; options: { key: string; text: string }[] }
);

export type PromptKind = Prompt['kind'];

export interface PromptDone { t:'game.promptDone'; seq: number; gameId: Id;
                              promptId: number; reason:'answered'|'superseded'|'gameOver' }

// client → server
export interface Answer {
  t: 'game.answer'; id: string; gameId: Id; promptId: number;
  answer:
    | { type:'confirm';  value: boolean }        // confirm; also priority pass = {confirm,false}
    | { type:'object';   objectId: Id }          // act on / target / mana source / ability id
    | { type:'objects';  objectIds: Id[] }       // multi-target submit (bridge feeds XMage one at a time)
    | { type:'number';   value: number }
    | { type:'option';   key: string }
    | { type:'pile';     index: 0 | 1 }
    | { type:'mana';     color: Color | 'C' }    // pay from pool
    | { type:'distribution'; amounts: { id: Id; amount: number }[] }
    | { type:'cancel' };
}

export type AnswerValue = Answer['answer'];

// ── §9 Player-initiated actions (no prompt required) ─────────────────────────

export interface GameAction {
  t:'game.action'; id: string; gameId: Id;
  action:
    | { kind:'concede' }
    | { kind:'skip'; mode:'stack'|'endOfTurn'|'nextMain'|'myNextTurn'
                    |'endStepBeforeMyTurn'|'cancel' }     // maps to PASS_PRIORITY_*
    | { kind:'requestRollback'; turns: number }           // gated by GameState.rollbackTurnsAllowed (§6)
    | { kind:'autoMana'; enabled: boolean }               // MANA_AUTO_PAYMENT_ON/OFF
    | { kind:'triggerOrder'; mode:'reset' };              // v1: reset only
}

export type GameActionValue = GameAction['action'];

// ── §10 Log and chat ─────────────────────────────────────────────────────────

export interface LogEntry { t:'game.log'; seq: number; gameId: Id; ts: number;
                            kind:'game'|'chat'|'status'|'error'|'personal';
                            turn?: string;                       // XMage turnInfo, e.g. "T2.M1"
                            text: string;                        // plain text, HTML stripped
                            refs?: { objectId: Id; name: string }[];  // cards mentioned in the line
                            playerId?: Id }                      // speaker / subject when known
export interface ChatSend { t:'chat.send'; id: string; gameId: Id; text: string }   // client → server

// ── §11 Game end ─────────────────────────────────────────────────────────────

export interface GameOver { t:'game.over'; seq: number; gameId: Id;
                            winnerPlayerIds: Id[];
                            reason: string;                      // human-readable, from XMage
                            finalState: true }                   // a final keyframe precedes this event

// ── §12 Errors ───────────────────────────────────────────────────────────────

export type ErrorCode =
  | 'UNSUPPORTED_VERSION' | 'AUTH_FAILED' | 'RESUME_FAILED'
  | 'BAD_MESSAGE'         | 'UNKNOWN_GAME'
  | 'PROMPT_STALE'        | 'INVALID_ANSWER'
  | 'DECK_INVALID'        | 'LOBBY_STATE'
  | 'UPSTREAM_ERROR';     // XMage session failure; fatal:true → seat lost

// ── Client-side assembly (not in v1.md): the two wire unions ─────────────────

export type ServerMsg =
  | Welcome | Ack | Err | LobbyState
  | StateKeyframe | StatePatch | Prompt | PromptDone | LogEntry | GameOver;

export type ClientMsg =
  | Hello
  | LobbyCreate | LobbyJoin | LobbyDeck | LobbyReady | LobbyStart
  | Resync | Answer | GameAction | ChatSend;
