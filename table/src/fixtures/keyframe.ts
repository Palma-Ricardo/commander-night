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

type CardOpts = Partial<Pick<Card, 'manaCost' | 'power' | 'toughness' | 'subtypes' | 'supertypes' | 'colors' | 'text'>>;

function card(name: string, set: string, number: string, manaValue: number, types: string[], o: CardOpts = {}): Card {
  return {
    id: uuid('c'), name, set, number, manaValue, types,
    subtypes: o.subtypes ?? [], supertypes: o.supertypes ?? [], colors: o.colors ?? [], text: o.text ?? [],
    ...(o.manaCost !== undefined ? { manaCost: o.manaCost } : {}),
    ...(o.power !== undefined ? { power: o.power } : {}),
    ...(o.toughness !== undefined ? { toughness: o.toughness } : {}),
  };
}

function perm(controllerId: string, c: Card, opts: { tapped?: boolean } = {}): Permanent {
  return { ...c, controllerId, tapped: opts.tapped ?? false };
}

const land = (name: string, colors: Card['colors']): Card =>
  card(name, 'CMR', '1', 0, ['LAND'], { colors, text: [`{T}: Add mana.`] });

const commander = (name: string, colors: Card['colors'], mc: string, pt: [string, string]): CommandObject => ({
  ...card(name, 'CMR', '2', mc.replace(/[^0-9]/g, '').length, ['LEGENDARY', 'CREATURE'],
    { manaCost: mc, colors, supertypes: ['Legendary'], power: pt[0], toughness: pt[1] }),
  kind: 'commander',
});

function seat(id: string, name: string, human: boolean, life: number, opts: {
  commander: CommandObject;
  battlefield: Permanent[];
  graveyard?: Card[];
  handSize: number;
  librarySize: number;
}): Player {
  return {
    id, name, human, life,
    manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
    librarySize: opts.librarySize, handSize: opts.handSize,
    battlefield: opts.battlefield,
    graveyard: opts.graveyard ?? [],
    exile: [],
    commandZone: [opts.commander],
  };
}

// ── the four seats ────────────────────────────────────────────────────────────

const you = seat('p1', 'You', true, 34, {
  commander: commander("Muldrotha, the Gravetide", ['B', 'G', 'U'], '{3}{B}{G}{U}', ['6', '6']),
  battlefield: [
    perm('p1', land('Forest', ['G']), { tapped: true }),
    perm('p1', land('Swamp', ['B'])),
    perm('p1', land('Island', ['U'])),
    perm('p1', card('Sol Ring', 'CMR', '3', 1, ['ARTIFACT'], { manaCost: '{1}', text: ['{T}: Add {C}{C}.'] })),
    perm('p1', card('Sakura-Tribe Elder', 'CMR', '4', 2, ['CREATURE'],
      { manaCost: '{1}{G}', colors: ['G'], subtypes: ['Snake', 'Shaman'], power: '1', toughness: '1' })),
  ],
  graveyard: [card('Eternal Witness', 'CMR', '5', 3, ['CREATURE'], { colors: ['G'], power: '2', toughness: '1' })],
  handSize: 4, librarySize: 71,
});

const ana = seat('p2', 'Ana', false, 22, {
  commander: commander('Krenko, Mob Boss', ['R'], '{2}{R}{R}', ['3', '3']),
  battlefield: [
    perm('p2', land('Mountain', ['R']), { tapped: true }),
    perm('p2', land('Mountain', ['R']), { tapped: true }),
    perm('p2', card('Goblin Token', 'CMR', '0', 0, ['CREATURE'],
      { colors: ['R'], subtypes: ['Goblin'], power: '1', toughness: '1', text: [] })),
  ],
  graveyard: [card('Lightning Bolt', 'CMR', '6', 1, ['INSTANT'], { colors: ['R'], text: ['Deal 3 damage.'] })],
  handSize: 2, librarySize: 63,
});

const tom = seat('p3', 'Tom', false, 40, {
  commander: commander('Tom, the Foretold', ['W', 'U'], '{2}{W}{U}', ['4', '5']),
  battlefield: [
    perm('p3', land('Plains', ['W'])),
    perm('p3', land('Island', ['U'])),
    perm('p3', card('Wall of Omens', 'CMR', '7', 2, ['CREATURE'],
      { manaCost: '{1}{W}', colors: ['W'], subtypes: ['Wall'], power: '0', toughness: '4' })),
  ],
  handSize: 6, librarySize: 74,
});

const marta = seat('p4', 'Marta', false, 31, {
  commander: commander('Marta, Relic Warden', ['W', 'B'], '{2}{W}{B}', ['3', '4']),
  battlefield: [
    perm('p4', land('Plains', ['W']), { tapped: true }),
    perm('p4', land('Swamp', ['B'])),
    perm('p4', card('Solemn Simulacrum', 'CMR', '8', 4, ['ARTIFACT', 'CREATURE'],
      { manaCost: '{4}', subtypes: ['Golem'], power: '2', toughness: '2' })),
  ],
  handSize: 3, librarySize: 68,
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
    stack: [
      {
        id: uuid('stk'), kind: 'spell', controllerId: 'p1', text: [],
        card: card('Cultivate', 'CMR', '9', 3, ['SORCERY'],
          { manaCost: '{2}{G}', colors: ['G'], text: ['Search your library for two basic lands.'] }),
      },
    ],
    me: {
      playerId: 'p1',
      hand: [
        card('Llanowar Elves', 'CMR', '10', 1, ['CREATURE'], { manaCost: '{G}', colors: ['G'], power: '1', toughness: '1' }),
        card('Counterspell', 'CMR', '11', 2, ['INSTANT'], { manaCost: '{U}{U}', colors: ['U'], text: ['Counter target spell.'] }),
        card('Reclamation Sage', 'CMR', '12', 3, ['CREATURE'], { manaCost: '{2}{G}', colors: ['G'], power: '2', toughness: '1' }),
        card('Command Tower', 'CMR', '13', 0, ['LAND'], { text: ['{T}: Add one mana of any color in your commander’s identity.'] }),
      ],
    },
  },
};
