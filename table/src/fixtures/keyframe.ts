// A synthetic mid-game 4-seat keyframe for the T0 render demo (design §13: "a
// captured turn-25 keyframe renders as a recognizable table"). No client-format
// capture that rich exists yet — the recorded sessions are bridge-side GameViews
// (pre-translation) and the one client sample is a sparse turn-3 two-hander — so
// this stands in until the table client can record its own. It is a *real*
// keyframe: authored as a typed StateKeyframe (tsc checks every field against
// GameState) and strict-decoded in test/keyframe.test.ts, dog-fooding the shared
// @night/core decoder.
//
// Seats follow the §7.2 mockup: you are bottom-left, turn order clockwise —
// You → Ana → Tom → Marta. Boards are lightly populated (commander, a few
// lands + permanents, a graveyard card) so the four quadrants read as a table.

import type { Card, CommandObject, Permanent, Player, StateKeyframe } from '@night/core';

let n = 0;
const uuid = (tag: string): string => `${tag}-${(++n).toString(16).padStart(4, '0')}-4a60`;

type CardOpts = Partial<Pick<Card,
  'manaCost' | 'power' | 'toughness' | 'subtypes' | 'supertypes' | 'colors' | 'text' | 'token' | 'imageNumber'>>;

function card(name: string, set: string, number: string, manaValue: number, types: string[], o: CardOpts = {}): Card {
  return {
    id: uuid('c'), name, set, number, manaValue, types,
    subtypes: o.subtypes ?? [], supertypes: o.supertypes ?? [], colors: o.colors ?? [], text: o.text ?? [],
    ...(o.manaCost !== undefined ? { manaCost: o.manaCost } : {}),
    ...(o.power !== undefined ? { power: o.power } : {}),
    ...(o.toughness !== undefined ? { toughness: o.toughness } : {}),
    ...(o.token !== undefined ? { token: o.token } : {}),
    ...(o.imageNumber !== undefined ? { imageNumber: o.imageNumber } : {}),
  };
}

function perm(controllerId: string, c: Card, opts: { tapped?: boolean } = {}): Permanent {
  return { ...c, controllerId, tapped: opts.tapped ?? false };
}

// Every card carries a *real* set + collector number so the Scryfall ladder's
// first rung (cards/{set}/{number}) resolves the correct art. The old fixture
// hardcoded CMR/1..13, so cards/cmr/1 returned whatever shares that number — a
// Plains rendered as "The Prismatic Piper" (CMR #1). A faithful-art harness is
// the whole point of the T4 review loop, so these are pinned to printings whose
// cards/{set}/{number} was verified to return the right card.

// The basic lands — flagged Basic on the wire (mage's SuperType.BASIC), which is
// what lets the table collapse a fistful of Forests into one ×N cell (T4).
const BASIC_PRINTING: Record<string, [string, string]> = {
  Plains: ['msc', '866'], Island: ['msh', '289'], Swamp: ['msh', '291'],
  Mountain: ['msc', '858'], Forest: ['msh', '295'],
};
const land = (name: string, colors: Card['colors']): Card => {
  const [set, number] = BASIC_PRINTING[name] ?? ['msh', '295'];
  return card(name, set, number, 0, ['LAND'], { colors, supertypes: ['Basic'], text: [`{T}: Add mana.`] });
};

const goblin = (): Permanent =>
  perm('p2', card('Goblin Token', 'CMR', '', 0, ['CREATURE'],
    { colors: ['R'], subtypes: ['Goblin'], power: '1', toughness: '1', text: [], token: true, imageNumber: 0 }));

const commander = (
  name: string, set: string, number: string, colors: Card['colors'], mc: string, pt: [string, string],
): CommandObject => ({
  ...card(name, set, number, mc.replace(/[^0-9]/g, '').length, ['LEGENDARY', 'CREATURE'],
    { manaCost: mc, colors, supertypes: ['Legendary'], power: pt[0], toughness: pt[1] }),
  kind: 'commander',
});

function seat(id: string, name: string, human: boolean, life: number, opts: {
  commander: CommandObject;
  battlefield: Permanent[];
  graveyard?: Card[];
  handSize: number;
  librarySize: number;
  commanderDamage?: Player['commanderDamage'];
  manaPool?: Player['manaPool'];
}): Player {
  return {
    id, name, human, life,
    manaPool: opts.manaPool ?? { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
    librarySize: opts.librarySize, handSize: opts.handSize,
    battlefield: opts.battlefield,
    graveyard: opts.graveyard ?? [],
    exile: [],
    commandZone: [opts.commander],
    ...(opts.commanderDamage !== undefined ? { commanderDamage: opts.commanderDamage } : {}),
  };
}

// Two opponents' commanders are hoisted so You can carry commander damage from
// them (the plate chips, T4): the *same* object must sit in the dealer's command
// zone for the name to resolve (commanderDamageRows → objectName).
const krenko = commander('Krenko, Mob Boss', 'fdn', '204', ['R'], '{2}{R}{R}', ['3', '3']);
const martaCmdr = commander('Elenda, the Dusk Rose', 'lcc', '268', ['W', 'B'], '{2}{W}{B}', ['1', '0']);

// ── the four seats ────────────────────────────────────────────────────────────

const you = seat('p1', 'You', true, 34, {
  commander: commander('Muldrotha, the Gravetide', 'ecc', '128', ['B', 'G', 'U'], '{3}{B}{G}{U}', ['6', '6']),
  battlefield: [
    perm('p1', land('Forest', ['G'])),
    perm('p1', land('Forest', ['G'])),
    perm('p1', land('Forest', ['G']), { tapped: true }),   // tapped ⇒ splits from the untapped pair
    perm('p1', land('Island', ['U'])),
    perm('p1', land('Island', ['U'])),
    perm('p1', land('Swamp', ['B'])),
    perm('p1', card('Sol Ring', 'msc', '211', 1, ['ARTIFACT'], { manaCost: '{1}', text: ['{T}: Add {C}{C}.'] })),
    perm('p1', card('Sakura-Tribe Elder', 'soc', '285', 2, ['CREATURE'],
      { manaCost: '{1}{G}', colors: ['G'], subtypes: ['Snake', 'Shaman'], power: '1', toughness: '1' })),
  ],
  graveyard: [card('Eternal Witness', 'cmm', '286', 3, ['CREATURE'], { colors: ['G'], power: '2', toughness: '1' })],
  handSize: 4, librarySize: 71,
  // Mid-cast: two Forests + Sol Ring tapped for Cultivate leave floating mana, so
  // the bottom-left pool window shows real glyph pips (T4 mana symbols).
  manaPool: { W: 0, U: 1, B: 0, R: 0, G: 2, C: 1 },
  // Beating on since turn 6: Krenko's swarm and Elenda have both connected.
  commanderDamage: [
    { fromCommanderId: krenko.id, amount: 9 },
    { fromCommanderId: martaCmdr.id, amount: 4 },
  ],
});

const ana = seat('p2', 'Ana', false, 22, {
  commander: krenko,
  battlefield: [
    perm('p2', land('Mountain', ['R'])),
    perm('p2', land('Mountain', ['R'])),
    perm('p2', land('Mountain', ['R'])),
    // Krenko's swarm: identical tokens as the wire sends them (scryfall.ts): token=true,
    // empty collector number, a " Token" name suffix — so the resolver takes its
    // token-search ladder (degrading to colour-only), and the table folds them into
    // one ×N cell instead of five. One is tapped, so it splits off (attacked?).
    goblin(), goblin(), goblin(), goblin(),
    { ...goblin(), tapped: true },
  ],
  graveyard: [card('Lightning Bolt', 'msc', '806', 1, ['INSTANT'], { colors: ['R'], text: ['Deal 3 damage.'] })],
  handSize: 2, librarySize: 63,
});

// Hoisted so the stack's Lightning Bolt can name it as a target (the §9 target
// tether draws from the pile to this permanent's world cell).
const tomWall = perm('p3', card('Wall of Omens', 'tdc', '138', 2, ['CREATURE'],
  { manaCost: '{1}{W}', colors: ['W'], subtypes: ['Wall'], power: '0', toughness: '4' }));

const tom = seat('p3', 'Tom', false, 40, {
  commander: commander('Brago, King Eternal', 'khc', '82', ['W', 'U'], '{2}{W}{U}', ['2', '4']),
  battlefield: [
    perm('p3', land('Plains', ['W'])),
    perm('p3', land('Island', ['U'])),
    tomWall,
  ],
  handSize: 6, librarySize: 74,
});

const marta = seat('p4', 'Marta', false, 31, {
  commander: martaCmdr,
  battlefield: [
    perm('p4', land('Plains', ['W']), { tapped: true }),
    perm('p4', land('Swamp', ['B'])),
    perm('p4', card('Solemn Simulacrum', 'msc', '215', 4, ['ARTIFACT', 'CREATURE'],
      { manaCost: '{4}', subtypes: ['Golem'], power: '2', toughness: '2' })),
  ],
  handSize: 3, librarySize: 68,
  // Marta is a left-corner seat, so her held fan sits to the right of the plate —
  // right where the commander-damage strip used to run, hiding it. Krenko has been
  // swinging (the strip now sits on the rail side of the plate, clear of the fan).
  commanderDamage: [{ fromCommanderId: krenko.id, amount: 15 }],
});

export const demoKeyframe: StateKeyframe = {
  t: 'game.state',
  seq: 480,
  gameId: 'demo',
  state: {
    gameId: 'demo',
    status: 'active',
    rollbackTurnsAllowed: false,
    turn: { n: 12, phase: 'PRECOMBAT_MAIN', step: 'PRE_MAIN', activePlayerId: 'p1', priorityPlayerId: 'p1' },
    players: [you, ana, tom, marta],
    // A 3-high stack (bottom → top): You cast Cultivate, Ana's Krenko trigger
    // answers, and you've responded on top with Counterspell — enough to exercise
    // the right-edge fan (a spell, a triggered ability, and the visible top item).
    stack: [
      {
        id: uuid('stk'), kind: 'spell', controllerId: 'p1', text: [],
        card: card('Cultivate', 'msc', '172', 3, ['SORCERY'],
          { manaCost: '{2}{G}', colors: ['G'], text: ['Search your library for two basic lands.'] }),
      },
      { id: uuid('stk'), kind: 'ability', controllerId: 'p2', text: ['Create a 1/1 red Goblin creature token.'],
        card: card('Krenko, Mob Boss', 'fdn', '204', 4, ['LEGENDARY', 'CREATURE'], { colors: ['R'], power: '3', toughness: '3' }) },
      { id: uuid('stk'), kind: 'spell', controllerId: 'p1', text: [], targets: [tomWall.id],
        card: card('Lightning Bolt', 'msc', '806', 1, ['INSTANT'], { colors: ['R'], text: ['Deal 3 damage to any target.'] }) },
    ],
    me: {
      playerId: 'p1',
      hand: [
        card('Llanowar Elves', 'fdn', '227', 1, ['CREATURE'], { manaCost: '{G}', colors: ['G'], power: '1', toughness: '1' }),
        card('Counterspell', 'dsc', '114', 2, ['INSTANT'], { manaCost: '{U}{U}', colors: ['U'], text: ['Counter target spell.'] }),
        card('Reclamation Sage', 'fdn', '231', 3, ['CREATURE'], { manaCost: '{2}{G}', colors: ['G'], power: '2', toughness: '1' }),
        card('Command Tower', 'msc', '233', 0, ['LAND'], { text: ['{T}: Add one mana of any color in your commander’s identity.'] }),
      ],
    },
  },
};
