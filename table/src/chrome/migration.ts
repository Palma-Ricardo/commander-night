// Strangler ownership (prompts-on-the-table §2): which prompt kinds still
// render their controls in the PromptDock, and which have moved to the corner
// cluster + canvas surfaces. One predicate consumed by BOTH PromptDock and
// CornerCluster, so a prompt can never render controls in two places — or in
// none.
//
// T7 moved confirm / priority (incl. combat) / chooseAmount. T8 moves
// chooseTargets whose candidates the board can actually offer: felt and hand
// candidates click on the canvas, player candidates click on their nameplates,
// and the corner cluster carries Submit/Done/Decline. The dock keeps only the
// bodies headed for T9's carousel — a `cards[]` grid, or candidates the board
// cannot reach (pile zones, ids outside this seat's view).

import type { GameState, Prompt } from '@night/core/protocol/protocol';
import { isBoardReachable } from '@night/core/state/selectors';

export function dockOwns(p: Prompt, state: GameState | undefined): boolean {
  switch (p.kind) {
    case 'confirm':
    case 'priority':
    case 'chooseAmount':
      return false;
    case 'chooseTargets': {
      if (p.cards !== undefined && p.cards.length > 0) return true;   // grid → T9 carousel
      if (state === undefined) return true;
      // Players are board-reachable since T8 (nameplate click + drag release);
      // anything else unreachable still needs the dock's stranded buttons.
      return p.candidates.some(id =>
        !isBoardReachable(state, id) && !state.players.some(pl => pl.id === id));
    }
    default:
      return true;
  }
}
