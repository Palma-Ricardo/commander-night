// Feel-tuning constants (prompts-on-the-table §9). Deliberately plain consts —
// adjusting one is a rebuild, not a settings surface (decided 2026-07-25).

/** Drag-to-cast: the bottom fraction of the viewport that still means "hand".
 *  A card released above this line casts; at or below it, it slides home.
 *  0.33 is the accepted starting point; Ricardo expects to tune toward 0.25. */
export const CAST_THRESHOLD = 0.33;

/** Pointer travel (px) before a press on a hand card becomes a drag rather
 *  than a click. Below this, the press stays an ordinary click-to-cast. */
export const DRAG_SLOP_PX = 6;

/** How long a not-cast card takes to slide back into the fan (ms). */
export const DRAG_HOME_MS = 180;

/** How long a carousel scroll or a hand-fan scroll settles (ms). */
export const PAGE_TURN_MS = 160;
