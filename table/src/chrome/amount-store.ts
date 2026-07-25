// chooseAmount's view-local draft value (prompts-on-the-table §4.1): the
// module that feeds the corner cluster deliberately excludes controls whose
// answer needs local input, so the screen-space AmountSelector writes its
// value here and the cluster's OK reads it. Keyed by promptId — a draft for
// a superseded ask is dead on arrival (the §7 fence, one prompt sideways).

import { createStore } from 'zustand/vanilla';

export interface AmountDraft { promptId: number; value: number }

export const amountStore = createStore<{ draft?: AmountDraft }>(() => ({}));
