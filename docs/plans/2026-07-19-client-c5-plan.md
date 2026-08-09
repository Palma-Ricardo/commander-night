# Client C5 — friends'-night readiness: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the C4 client to a state that can host a real 4-human Commander night on the
deployed VPS: images warm before the first turn, the board reads well on 1080p/1440p+ screens,
piles and hover previews are usable, a backgrounded tab announces priority, and the production
build ships behind caddy.

**Architecture:** Four self-contained client changes (deck-text image warm-up, title-flash nudge,
pile filter/sort, hover anchoring) plus a CSS scaling pass driven by a throwaway layout harness,
then deploy wiring. Pure logic lands behind vitest first; the visual work is tuned against a
real captured keyframe; the deploy is validated by running the existing auto-player against the
actual production bundle.

**Tech Stack:** TypeScript (strict), React 19, zustand vanilla stores, vitest, Playwright, Vite 8,
caddy.

**Spec:** `docs/plans/2026-07-19-client-c5-design.md`

## Global Constraints

- TypeScript strict; `npm test` runs `tsc --noEmit && vitest run` and must stay green.
- The Playwright driver (`e2e/pw/driver.ts`) selects on **class names**. CSS work may change
  sizing, positioning, and structure-internal styling, but must not rename or remove existing
  class names used by `e2e/pw/*.spec.ts`.
- Stores are framework-free zustand vanilla; components read, actions write (design §4).
- New modules take injected dependencies (`document`, `fetch`, `kv`) so they test headlessly —
  follow the pattern in `src/images/scryfall.ts` and `test/scryfall.test.ts`.
- Scryfall lookups stay paced at the existing ~8 req/s (`minIntervalMs` default 125). Warm-up
  must not raise it.
- Commit after every task.

---

### Task 1: `.dck` → card identities parser

**Files:**
- Create: `client/src/images/deck.ts`
- Create: `client/test/deck.test.ts`

**Interfaces:**
- Consumes: `CardIdentity` from `src/images/scryfall.ts` — `{ set: string; number: string; name: string; token?: boolean }`.
- Produces: `parseDeckIdentities(text: string): CardIdentity[]` — deduped, main deck + sideboard, layout metadata excluded.

**Background — the real format.** `upgrades_unleashed.dck` at the repo root is the reference:

```
1 [MKC:145] Agitator Ant
SB: 1 [NEC:1] Chishiro, the Shattered Blade
LAYOUT MAIN:(1,1)(NONE,false,50)|([MKC:145],[NEC:18],[ELD:331],…)
LAYOUT SIDEBOARD:(1,1)(NONE,false,50)|([NEC:1])
```

Three things that must be handled: the `SB:` line is the **commander** in a Commander deck (the
most-seen card in the game — warming it matters most), the `LAYOUT` lines repeat every identity
so a whole-text regex scan would parse the deck twice, and identities repeat legitimately in the
main deck (`[HOB:198]` appears nine times) so results must dedupe.

- [ ] **Step 1: Write the failing test**

Create `client/test/deck.test.ts`:

```ts
// Deck-text → image-warm identities (C5, design §9). The .dck trap: LAYOUT
// lines repeat every [SET:NUM] identity, so a whole-text scan double-counts.

import { describe, expect, it } from 'vitest';
import { parseDeckIdentities } from '../src/images/deck';

describe('parseDeckIdentities', () => {
  it('parses main-deck lines into set/number/name', () => {
    const out = parseDeckIdentities('1 [MKC:145] Agitator Ant\n1 [NEC:18] Akki Battle Squad\n');
    expect(out).toEqual([
      { set: 'MKC', number: '145', name: 'Agitator Ant' },
      { set: 'NEC', number: '18', name: 'Akki Battle Squad' },
    ]);
  });

  it('includes the SB: line — in Commander that is the commander', () => {
    const out = parseDeckIdentities('SB: 1 [NEC:1] Chishiro, the Shattered Blade\n');
    expect(out).toEqual([{ set: 'NEC', number: '1', name: 'Chishiro, the Shattered Blade' }]);
  });

  it('skips LAYOUT metadata lines', () => {
    const text = '1 [MKC:145] Agitator Ant\n'
      + 'LAYOUT MAIN:(1,1)(NONE,false,50)|([MKC:145],[NEC:18],[ELD:331])\n'
      + 'LAYOUT SIDEBOARD:(1,1)(NONE,false,50)|([NEC:1])\n';
    expect(parseDeckIdentities(text)).toEqual([
      { set: 'MKC', number: '145', name: 'Agitator Ant' },
    ]);
  });

  it('dedupes repeated identities (basics appear many times)', () => {
    const text = '1 [HOB:198] Forest\n1 [HOB:198] Forest\n1 [HOB:198] Forest\n';
    expect(parseDeckIdentities(text)).toHaveLength(1);
  });

  it('ignores blank, whitespace, and malformed lines', () => {
    const text = '\n   \n1 [MKC:145] Agitator Ant\nnot a card line\n1 [BAD] Missing Colon\n';
    expect(parseDeckIdentities(text)).toEqual([
      { set: 'MKC', number: '145', name: 'Agitator Ant' },
    ]);
  });

  it('handles quantities greater than one and surrounding whitespace', () => {
    expect(parseDeckIdentities('  12 [HOB:197] Mountain  \n')).toEqual([
      { set: 'HOB', number: '197', name: 'Mountain' },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx vitest run test/deck.test.ts`
Expected: FAIL — `Failed to resolve import "../src/images/deck"`.

- [ ] **Step 3: Write the implementation**

Create `client/src/images/deck.ts`:

```ts
// Deck text → card identities, for the C5 image cache warm-up (design §9).
//
// XMage .dck lines:
//   1 [MKC:145] Agitator Ant           main deck
//   SB: 1 [NEC:1] Chishiro, ...        sideboard — the commander, in Commander
//   LAYOUT MAIN:(…)|([MKC:145],…)      trailing layout metadata
//
// The LAYOUT lines repeat every identity in the deck, so this parses line by
// line and skips them: a whole-text regex scan would yield the deck twice.
// Identities also repeat legitimately (nine copies of [HOB:198]), so the
// result is deduped on the resolver's own set/number identity.

import type { CardIdentity } from './scryfall';

const CARD_LINE = /^(?:SB:\s*)?\d+\s+\[([^:\]]+):([^\]]*)\]\s+(.+?)$/;

export function parseDeckIdentities(text: string): CardIdentity[] {
  const out: CardIdentity[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('LAYOUT')) continue;
    const m = CARD_LINE.exec(line);
    if (m === null) continue;
    const [, set, number, name] = m as unknown as [string, string, string, string];
    const key = `${set.toLowerCase()}/${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ set, number, name: name.trim() });
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx vitest run test/deck.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Sanity-check against the real deck file**

Run:
```sh
cd client && npx tsx -e "
import fs from 'node:fs';
import { parseDeckIdentities } from './src/images/deck.ts';
const t = fs.readFileSync('../upgrades_unleashed.dck','utf8');
const out = parseDeckIdentities(t);
console.log(out.length, JSON.stringify(out[0]), JSON.stringify(out.at(-1)));
"
```
Expected: a count in the 80–95 range (100 cards deduped to unique printings), the first entry
`{"set":"MKC","number":"145","name":"Agitator Ant"}`, and no entry whose `name` contains a
bracket or a comma-separated identity list (which would mean a LAYOUT line leaked through).

If `tsx` is not installed, skip this step — the unit tests cover the same ground; do not add a
dependency for it.

- [ ] **Step 6: Commit**

```bash
cd /home/ricardop/Projects/commander-night
git add client/src/images/deck.ts client/test/deck.test.ts
git commit -m "C5: .dck → card identity parser for image warm-up

LAYOUT lines repeat every identity, so parsing is line-by-line rather
than a whole-text scan; SB: is included because in Commander that line
is the commander."
```

---

### Task 2: Warm the image cache on deck submit

**Files:**
- Modify: `client/src/net/actions.ts` (factory signature, `submitDeckFlow`)
- Modify: `client/src/app.ts` (construction order + wiring)
- Modify: `client/test/actions.test.ts` (new describe block)

**Interfaces:**
- Consumes: `parseDeckIdentities` (Task 1); `ScryfallResolver['resolve']` from `src/images/scryfall.ts` — `resolve(card: CardIdentity, priority: 0 | 1 | 2): void`.
- Produces: `createActions(stores, manager, kv, opts?: { scryfall?: Pick<ScryfallResolver, 'resolve'> })` — a fourth optional parameter. Existing three-argument callers keep working unchanged.

**Why priority 2:** the resolver's queue is priority-ordered (0 = hand/commanders, 1 =
battlefield, 2 = piles). Warm-up enqueues ~90 cards; at priority 2 any card that becomes visible
during the warm still preempts the backlog via the existing `resolve()` priority-upgrade path.

- [ ] **Step 1: Write the failing test**

Append to `client/test/actions.test.ts`:

```ts
describe('submitDeck image warm-up (C5)', () => {
  it('queues every deck identity at pile priority on submit', async () => {
    const warmed: { set: string; number: string; name: string; priority: number }[] = [];
    const warmActions = createActions(stores, fakeManager, kv, {
      scryfall: { resolve: (card, priority) => warmed.push({ ...card, priority }) },
    });
    warmActions.setDeckText('1 [MKC:145] Agitator Ant\nSB: 1 [NEC:1] Chishiro\n');

    await warmActions.submitDeck();

    expect(warmed).toEqual([
      { set: 'MKC', number: '145', name: 'Agitator Ant', priority: 2 },
      { set: 'NEC', number: '1', name: 'Chishiro', priority: 2 },
    ]);
  });

  it('still submits the deck when no resolver is wired', async () => {
    actions.setDeckText('1 [MKC:145] Agitator Ant\n');
    await actions.submitDeck();
    expect(sent.some(c => c.t === 'lobby.deck')).toBe(true);
  });

  it('does not warm when the deck text is empty', async () => {
    const warmed: unknown[] = [];
    const warmActions = createActions(stores, fakeManager, kv, {
      scryfall: { resolve: () => warmed.push(1) },
    });
    warmActions.setDeckText('');
    await warmActions.submitDeck();
    expect(warmed).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx vitest run test/actions.test.ts`
Expected: FAIL — `createActions` accepts 3 arguments (TS error), and `warmed` is empty.

- [ ] **Step 3: Implement — actions factory**

In `client/src/net/actions.ts`, add the import at the top with the other imports:

```ts
import { parseDeckIdentities } from '../images/deck';
import type { ScryfallResolver } from '../images/scryfall';
```

Change the factory signature (currently line 32):

```ts
export interface ActionsOpts {
  /** C5 image warm-up: deck identities are queued here on submit (design §9).
   *  Optional so headless tests and the replay tier need no resolver. */
  scryfall?: Pick<ScryfallResolver, 'resolve'>;
}

export function createActions(
  stores: Stores,
  manager: SocketManager,
  kv: KV,
  opts: ActionsOpts = {},
) {
```

Replace `submitDeckFlow` (currently around line 113):

```ts
  /** Submit the deck, then warm the image cache from its identities (C5,
   *  design §9): ~90 unique printings at pile priority during lobby idle, so
   *  the first turns are not a slideshow on a cold cache. Fire-and-forget —
   *  the resolver queues internally and a warm failure is cosmetic. */
  async function submitDeckFlow(): Promise<void> {
    const content = stores.session.getState().deckText;
    unwrap(await manager.send(lobbyDeck(ctx, { format: 'dck', content })));
    if (opts.scryfall !== undefined && content.trim() !== '') {
      for (const card of parseDeckIdentities(content)) opts.scryfall.resolve(card, 2);
    }
  }
```

- [ ] **Step 4: Implement — app wiring**

In `client/src/app.ts`, the resolver must be constructed **before** the actions that consume it.
Replace the `appActions` / `appScryfall` pair:

```ts
export const appScryfall = createScryfallResolver({ kv: appKV });
export const appActions = createActions(appStores, appManager, appKV, { scryfall: appScryfall });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd client && npm test`
Expected: PASS — full suite green including the three new warm-up tests.

- [ ] **Step 6: Commit**

```bash
cd /home/ricardop/Projects/commander-night
git add client/src/net/actions.ts client/src/app.ts client/test/actions.test.ts
git commit -m "C5: warm the image cache from deck text on submit

~90 unique printings queued at pile priority during lobby idle. The
resolver is injected, so headless tests and the replay tier need none."
```

---

### Task 3: Background-tab priority nudge module

**Files:**
- Create: `client/src/ui/nudge.ts`
- Create: `client/test/nudge.test.ts`

**Interfaces:**
- Consumes: `PromptStoreState` from `src/stores/prompt.ts` (`{ pending?: Prompt, … }`); `Prompt.kind === 'priority'` from `src/protocol/protocol.ts`.
- Produces: `startNudge(opts: NudgeOpts): () => void` (returns a dispose function); `NUDGE_TITLE` constant; `NudgeDoc` and `NudgeOpts` interfaces.

**Why `document` is injected:** Playwright cannot reliably drive real tab backgrounding
(`document.hidden` is not writable from page script), so the whole state machine is proven
headlessly against a stub. This is a deliberate spec decision, not a shortcut.

- [ ] **Step 1: Write the failing test**

Create `client/test/nudge.test.ts`:

```ts
// Background-tab priority nudge (C5). document is injected because a real
// backgrounded tab is not drivable from Playwright — this is the whole test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NUDGE_TITLE, startNudge, type NudgeDoc } from '../src/ui/nudge';
import { createPromptStore } from '../src/stores/prompt';
import type { Prompt } from '../src/protocol/protocol';

const priority = (promptId: number): Prompt =>
  ({ kind: 'priority', promptId, actions: [] } as unknown as Prompt);
const confirm = (promptId: number): Prompt =>
  ({ kind: 'confirm', promptId, message: 'ok?' } as unknown as Prompt);

function fakeDoc(): NudgeDoc & { fire(): void } {
  const listeners: (() => void)[] = [];
  return {
    hidden: false,
    title: 'Commander Night',
    addEventListener(_t, fn) { listeners.push(fn); },
    removeEventListener(_t, fn) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    fire() { for (const fn of [...listeners]) fn(); },
  };
}

let doc: ReturnType<typeof fakeDoc>;
let prompt: ReturnType<typeof createPromptStore>;
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  doc = fakeDoc();
  prompt = createPromptStore();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

describe('startNudge', () => {
  it('does not flash while the tab is visible', () => {
    stop = startNudge({ doc, prompt });
    prompt.setState({ pending: priority(1) });
    vi.advanceTimersByTime(5000);
    expect(doc.title).toBe('Commander Night');
  });

  it('flashes when a priority prompt arrives while hidden', () => {
    doc.hidden = true;
    stop = startNudge({ doc, prompt });
    prompt.setState({ pending: priority(1) });
    vi.advanceTimersByTime(1200);
    expect(doc.title).toBe(NUDGE_TITLE);
    vi.advanceTimersByTime(1200);
    expect(doc.title).toBe('Commander Night');
  });

  it('does not flash for non-priority prompts', () => {
    doc.hidden = true;
    stop = startNudge({ doc, prompt });
    prompt.setState({ pending: confirm(1) });
    vi.advanceTimersByTime(5000);
    expect(doc.title).toBe('Commander Night');
  });

  it('restores the title when the tab is foregrounded', () => {
    doc.hidden = true;
    stop = startNudge({ doc, prompt });
    prompt.setState({ pending: priority(1) });
    vi.advanceTimersByTime(1200);
    expect(doc.title).toBe(NUDGE_TITLE);

    doc.hidden = false;
    doc.fire();
    expect(doc.title).toBe('Commander Night');
    vi.advanceTimersByTime(5000);
    expect(doc.title).toBe('Commander Night');
  });

  it('restores the title when the prompt resolves', () => {
    doc.hidden = true;
    stop = startNudge({ doc, prompt });
    prompt.setState({ pending: priority(1) });
    vi.advanceTimersByTime(1200);
    expect(doc.title).toBe(NUDGE_TITLE);

    prompt.setState({ pending: undefined });
    expect(doc.title).toBe('Commander Night');
  });

  it('restores the title and detaches on dispose', () => {
    doc.hidden = true;
    const dispose = startNudge({ doc, prompt });
    prompt.setState({ pending: priority(1) });
    vi.advanceTimersByTime(1200);
    expect(doc.title).toBe(NUDGE_TITLE);

    dispose();
    expect(doc.title).toBe('Commander Night');
    vi.advanceTimersByTime(5000);
    expect(doc.title).toBe('Commander Night');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx vitest run test/nudge.test.ts`
Expected: FAIL — `Failed to resolve import "../src/ui/nudge"`.

- [ ] **Step 3: Write the implementation**

Create `client/src/ui/nudge.ts`:

```ts
// Background-tab priority nudge (C5). While a `priority` prompt is pending and
// the tab is hidden, alternate the document title. Restores on foreground, on
// the prompt resolving, and on dispose.
//
// Title flash is the whole feature — the chime was cut at design time, so
// there is no audio asset, no autoplay unlock, and no settings surface.
//
// `document` is injected: a genuinely backgrounded tab is not drivable from
// Playwright, so this state machine is proven headlessly (design §13).

import type { StoreApi } from 'zustand/vanilla';
import type { PromptStoreState } from '../stores/prompt';

export interface NudgeDoc {
  hidden: boolean;
  title: string;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

export interface NudgeOpts {
  doc: NudgeDoc;
  prompt: StoreApi<PromptStoreState>;
  /** Alternation period; default 1200 ms. */
  periodMs?: number;
}

export const NUDGE_TITLE = '● Your turn';

export function startNudge(opts: NudgeOpts): () => void {
  const { doc, prompt } = opts;
  const period = opts.periodMs ?? 1200;

  let timer: ReturnType<typeof setInterval> | null = null;
  let baseTitle = '';
  let showingNudge = false;

  const shouldFlash = (): boolean =>
    doc.hidden && prompt.getState().pending?.kind === 'priority';

  function start(): void {
    if (timer !== null) return;
    baseTitle = doc.title;          // captured while quiescent — never a nudge title
    showingNudge = false;
    timer = setInterval(() => {
      showingNudge = !showingNudge;
      doc.title = showingNudge ? NUDGE_TITLE : baseTitle;
    }, period);
  }

  function stop(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    doc.title = baseTitle;
    showingNudge = false;
  }

  function evaluate(): void {
    if (shouldFlash()) start();
    else stop();
  }

  const unsubscribe = prompt.subscribe(evaluate);
  doc.addEventListener('visibilitychange', evaluate);
  evaluate();

  return () => {
    unsubscribe();
    doc.removeEventListener('visibilitychange', evaluate);
    stop();
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx vitest run test/nudge.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
cd /home/ricardop/Projects/commander-night
git add client/src/ui/nudge.ts client/test/nudge.test.ts
git commit -m "C5: background-tab priority nudge (title flash)

document injected — a real backgrounded tab is not drivable from
Playwright, so the state machine is proven headlessly."
```

---

### Task 4: Wire the nudge into the app shell

**Files:**
- Modify: `client/src/ui/App.tsx`

**Interfaces:**
- Consumes: `startNudge` (Task 3); `appStores.prompt` from `src/app.ts`.
- Produces: nothing new — a side effect mounted for the app's lifetime.

- [ ] **Step 1: Add the effect**

In `client/src/ui/App.tsx`, add to the imports:

```ts
import { startNudge } from './nudge';
```

Then add this effect immediately after the existing backtick-toggle `useEffect` (which ends with
`}, []);` around line 42):

```tsx
  // C5: a backgrounded tab announces priority in the tab strip. Mounted for
  // the app's lifetime — the module no-ops until a priority prompt is pending
  // while document.hidden.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    return startNudge({ doc: document, prompt: appStores.prompt });
  }, []);
```

- [ ] **Step 2: Verify types and the suite**

Run: `cd client && npm test`
Expected: PASS — `tsc --noEmit` clean (the real `Document` structurally satisfies `NudgeDoc`)
and the full vitest suite green.

- [ ] **Step 3: Verify by hand in the browser**

With XMage, the bridge, and `npm run dev` running (see CLAUDE.md → Commands), start a game
against AI fill, switch to another tab while it is your priority, and confirm the tab title
alternates with `● Your turn`. Switch back and confirm it stops and the original title returns.

If you cannot run a live game at this point, defer this step to Task 10's verification pass and
note it as deferred rather than marking it done.

- [ ] **Step 4: Commit**

```bash
cd /home/ricardop/Projects/commander-night
git add client/src/ui/App.tsx
git commit -m "C5: mount the background-tab priority nudge"
```

---

### Task 5: Pile browser — filter, sort, and Escape

**Files:**
- Create: `client/src/ui/board/pile.ts`
- Create: `client/test/pile.test.ts`
- Modify: `client/src/ui/board/Modal.tsx`
- Modify: `client/src/styles.css`

**Interfaces:**
- Consumes: `Card` from `src/protocol/protocol.ts` — relevant fields `name: string`, `types: string[]` (uppercase, e.g. `CREATURE`), `manaValue: number`.
- Produces: `filterSortPile(cards: Card[], filter: string): Card[]`; `CardGrid` gains an optional `browsable?: boolean` prop that renders the filter box.

**Design note:** sort is by primary type rank, then `manaValue`, then `name` — the order a player
scans a graveyard in. `Card.types` is uppercase per the protocol type's own comment.

- [ ] **Step 1: Write the failing test**

Create `client/test/pile.test.ts`:

```ts
// Pile browser ordering + filtering (C5). A 40-card graveyard is a wall
// scanned by eye without these.

import { describe, expect, it } from 'vitest';
import { filterSortPile } from '../src/ui/board/pile';
import type { Card } from '../src/protocol/protocol';

const card = (name: string, types: string[], manaValue: number): Card =>
  ({
    id: name, name, set: 'X', number: '1', manaValue, types,
    subtypes: [], supertypes: [], colors: [], text: [],
  } as unknown as Card);

const names = (cards: Card[]) => cards.map(c => c.name);

describe('filterSortPile', () => {
  it('orders by type rank, then mana value, then name', () => {
    const pile = [
      card('Forest', ['LAND'], 0),
      card('Shock', ['INSTANT'], 1),
      card('Bear', ['CREATURE'], 2),
      card('Ant', ['CREATURE'], 2),
      card('Bird', ['CREATURE'], 1),
    ];
    expect(names(filterSortPile(pile, ''))).toEqual(
      ['Bird', 'Ant', 'Bear', 'Shock', 'Forest'],
    );
  });

  it('filters on name, case-insensitively', () => {
    const pile = [card('Agitator Ant', ['CREATURE'], 2), card('Forest', ['LAND'], 0)];
    expect(names(filterSortPile(pile, 'ant'))).toEqual(['Agitator Ant']);
    expect(names(filterSortPile(pile, 'FOR'))).toEqual(['Forest']);
  });

  it('treats an empty or whitespace filter as no filter', () => {
    const pile = [card('Forest', ['LAND'], 0), card('Bear', ['CREATURE'], 2)];
    expect(filterSortPile(pile, '   ')).toHaveLength(2);
  });

  it('ranks unknown types last without dropping them', () => {
    const pile = [card('Weird', ['CONSPIRACY'], 0), card('Bear', ['CREATURE'], 2)];
    expect(names(filterSortPile(pile, ''))).toEqual(['Bear', 'Weird']);
  });

  it('does not mutate the input array', () => {
    const pile = [card('Forest', ['LAND'], 0), card('Bear', ['CREATURE'], 2)];
    const before = names(pile);
    filterSortPile(pile, '');
    expect(names(pile)).toEqual(before);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx vitest run test/pile.test.ts`
Expected: FAIL — `Failed to resolve import "../src/ui/board/pile"`.

- [ ] **Step 3: Write the implementation**

Create `client/src/ui/board/pile.ts`:

```ts
// Pile browser ordering + filtering (C5). Graveyards and exile arrive in game
// order, which is the wrong order for finding a card: scan order is type, then
// cost, then name. Pure — the modal is a thin shell over this.

import type { Card } from '../../protocol/protocol';

// Card.types is uppercase on the wire (protocol §1: "CREATURE, INSTANT, …").
const TYPE_RANK = [
  'CREATURE', 'PLANESWALKER', 'INSTANT', 'SORCERY',
  'ARTIFACT', 'ENCHANTMENT', 'BATTLE', 'LAND',
];

function rankOf(card: Card): number {
  for (let i = 0; i < TYPE_RANK.length; i++) {
    if (card.types.includes(TYPE_RANK[i]!)) return i;
  }
  return TYPE_RANK.length;   // unknown types sort last, never dropped
}

export function filterSortPile(cards: Card[], filter: string): Card[] {
  const needle = filter.trim().toLowerCase();
  const kept = needle === ''
    ? [...cards]
    : cards.filter(c => c.name.toLowerCase().includes(needle));
  return kept.sort((a, b) =>
    rankOf(a) - rankOf(b)
    || a.manaValue - b.manaValue
    || a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx vitest run test/pile.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into the modal**

In `client/src/ui/board/Modal.tsx`, replace the whole file:

```tsx
// Shared modal + card grid: graveyard/exile browsers (§8), chooseTargets card
// grids and pile columns (§7). C5 adds Escape-to-close and, for pile browsers,
// a name filter over the C5 scan ordering (pile.ts).

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Card } from '../../protocol/protocol';
import { CardView, type CardSize } from '../cards/CardView';
import { filterSortPile } from './pile';

export function Modal({ title, onClose, children }: { title: string; onClose?: () => void; children: ReactNode }) {
  // C5: Escape closes. Backdrop-click alone meant a keyboard-driven player had
  // to reach for the mouse to leave a graveyard.
  useEffect(() => {
    if (onClose === undefined) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <header>
          <h3>{title}</h3>
          {onClose !== undefined && <button className="modal-close" onClick={onClose}>✕</button>}
        </header>
        {children}
      </div>
    </div>
  );
}

export function CardGrid({ cards, size = 'grid', onCardClick, selectedIds, browsable = false }: {
  cards: Card[];
  size?: CardSize;
  onCardClick?: (card: Card) => void;
  selectedIds?: string[];
  /** Pile browsers (§8): scan ordering + a name filter. Prompt grids keep
   *  server candidate order — reordering a choice list would be lying. */
  browsable?: boolean;
}) {
  const [filter, setFilter] = useState('');
  const shown = useMemo(
    () => (browsable ? filterSortPile(cards, filter) : cards),
    [browsable, cards, filter],
  );

  if (cards.length === 0) return <p className="muted">empty</p>;
  return (
    <>
      {browsable && (
        <input
          className="pile-filter"
          type="search"
          placeholder={`filter ${cards.length} cards…`}
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      )}
      <div className="card-grid">
        {shown.map(c => (
          <CardView
            key={c.id}
            card={c}
            size={size}
            priority={2}
            onClickOverride={onCardClick !== undefined ? () => onCardClick(c) : undefined}
            selectedOverride={selectedIds?.includes(c.id)}
          />
        ))}
      </div>
      {browsable && shown.length === 0 && <p className="muted">no card matches “{filter}”</p>}
    </>
  );
}
```

**Important:** only the graveyard/exile browsers pass `browsable`. Prompt-driven grids
(`chooseTargets`, pile columns) must keep server candidate order — reordering a choice list would
misrepresent the server's options.

- [ ] **Step 6: Pass `browsable` from the pile browser call site**

There is exactly one pile-browser call site: `client/src/ui/screens/Game.tsx:119`, rendering the
`onBrowse` payload from `SeatPanel`'s GY/Exile buttons. Change it from:

```tsx
          <CardGrid cards={browse.cards} />
```

to:

```tsx
          <CardGrid cards={browse.cards} browsable />
```

Leave the two `CardGrid` usages in `PromptDock.tsx` (lines 156 and 250) **unchanged** — those are
`choosePile` columns and `chooseTargets` candidates, which must keep server order.

- [ ] **Step 7: Add the filter styling**

In `client/src/styles.css`, add next to the other `.modal` rules (around line 442):

```css
.pile-filter {
  width: 100%; margin: 0 0 0.6rem; padding: 0.35rem 0.5rem;
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: 4px; font-size: 0.9rem;
}
```

- [ ] **Step 8: Verify**

Run: `cd client && npm test`
Expected: PASS — full suite green.

- [ ] **Step 9: Commit**

```bash
cd /home/ricardop/Projects/commander-night
git add client/src/ui/board/pile.ts client/test/pile.test.ts \
        client/src/ui/board/Modal.tsx client/src/styles.css client/src/ui/
git commit -m "C5: pile browsers gain scan ordering, a name filter, and Escape

Ordering is type → mana value → name. Only graveyard/exile browsers opt
in; prompt grids keep server candidate order."
```

---

### Task 6: Layout harness — capture a real keyframe and mount it

**Files:**
- Modify: `client/src/app.ts` (temporary `dumpState` on the dev handle)
- Create: `client/e2e/pw/capture-layout.spec.ts` (temporary)
- Create: `client/e2e/artifacts/layout-keyframe.json` (temporary, generated)
- Create: `client/e2e/artifacts/layout-keyframe-fat.json` (temporary, hand-authored)
- Create: `client/src/dev/LayoutHarness.tsx` (temporary)
- Modify: `client/src/ui/App.tsx` (temporary `#/layout` route)

**Interfaces:**
- Consumes: `driveGame`, `snapshot` from `e2e/pw/driver.ts`; `GameState` from `src/protocol/protocol.ts`.
- Produces: `window.__night.dumpState(): GameState | null`; a `#/layout` route rendering `Game` against a fixture.

**Everything in this task is deleted in Task 11.** It exists to make the CSS pass evidence-based;
it is not shipped.

- [ ] **Step 1: Add the state dump to the dev handle**

In `client/src/app.ts`, extend the `declare global` block and the dev assignment:

```ts
declare global {
  interface Window {
    __night?: {
      snapshot(): NightSnapshot;
      /** C5 layout harness (temporary): the full keyframe, for fixture capture. */
      dumpState(): unknown;
    };
  }
}
```

and inside the `if (import.meta.env.DEV …)` block, alongside `snapshot`:

```ts
    dumpState: () => appStores.game.getState().state ?? null,
```

- [ ] **Step 2: Write the capture spec**

Create `client/e2e/pw/capture-layout.spec.ts`:

```ts
// C5 layout-fixture capture (temporary — removed with the harness in Task 11).
// Drives a real game to a dense mid-game board and dumps the keyframe, so the
// CSS pass is tuned against real data rather than a guess.
//
// Requires XMage + bridge + `npm run dev`, exactly like autoplayer.spec.ts.

import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { driveGame } from './driver';

const DECK = fs.readFileSync(
  fileURLToPath(new URL('../../../upgrades_unleashed.dck', import.meta.url)), 'utf8');

const OUT = fileURLToPath(new URL('../artifacts/layout-keyframe.json', import.meta.url));
const TARGET_TURN = 12;             // dense enough for a layout pass; reachable
                                    // well inside an AI-pace game

test('capture a dense mid-game keyframe for the layout harness', async ({ page }) => {
  test.setTimeout(30 * 60_000);

  await page.goto('/');
  await expect(page.locator('.status')).toHaveText('connected');
  await page.getByPlaceholder('how the table sees you').fill('LayoutRicardo');
  await page.getByRole('button', { name: 'Create lobby' }).click();
  await expect(page.locator('.lobby-code .code')).toBeVisible();

  await page.locator('.deck-editor textarea').fill(DECK);
  await page.getByRole('button', { name: 'Submit deck' }).click();
  await expect(page.locator('.deck-ok')).toHaveCount(1, { timeout: 15_000 });
  await page.locator('.deck-controls input[type=checkbox]').click();
  await expect(page.locator('.seat-ready')).toHaveCount(1, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page.locator('.status-line')).toBeVisible({ timeout: 120_000 });

  const result = await driveGame(page, {
    label: 'capture',
    deadlineAt: Date.now() + 25 * 60_000,
    goalCombat: 1,
    stopWhen: snap => (snap.turn ?? 0) >= TARGET_TURN,
  });

  // A finished game is still a usable capture; an empty one is not.
  const state = await page.evaluate(() => window.__night?.dumpState() ?? null);
  expect(state, 'no game state to dump — did the game end before turn 12?').not.toBeNull();

  fs.mkdirSync(fileURLToPath(new URL('../artifacts', import.meta.url)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(state, null, 2));
  console.log(`[capture] wrote ${OUT} (turn ${result.final?.turn ?? '?'})`);
});
```

- [ ] **Step 3: Run the capture**

Start the three processes in separate terminals (CLAUDE.md → Commands):

```sh
# 1. XMage
(cd vendor/xmage-dist/xmage/mage-server && ../../java/jre1.8.0_201/bin/java -Xmx2048m -jar lib/mage-server-1.4.60.jar)
# 2. bridge
cd bridge && mvn -Prun compile exec:exec
# 3. dev server
cd client && npm run dev
```

Then:

```sh
cd client && npx playwright test e2e/pw/capture-layout.spec.ts
```

Expected: the spec passes and prints `[capture] wrote …/layout-keyframe.json (turn 12)` or
later. Confirm the file is non-trivial:

```sh
cd client && node -e "
const s = require('./e2e/artifacts/layout-keyframe.json');
console.log('turn', s.turn.n, 'players', s.players.length,
  'battlefield', s.players.map(p => p.battlefield.length).join('/'),
  'graveyards', s.players.map(p => p.graveyard.length).join('/'));
"
```

Expected: 4 players and a non-zero battlefield on at least two of them. If every battlefield is
near-empty, raise `TARGET_TURN` and re-run — a sparse capture defeats the purpose.

- [ ] **Step 4: Hand-fatten a worst-case variant**

Create `client/e2e/artifacts/layout-keyframe-fat.json` by transforming the capture — this is the
density ceiling the layout must survive, not a realistic board:

```sh
cd client && node -e "
const fs = require('fs');
const s = JSON.parse(fs.readFileSync('./e2e/artifacts/layout-keyframe.json','utf8'));
const clone = o => JSON.parse(JSON.stringify(o));
let n = 0;
const reid = c => { const x = clone(c); x.id = 'fat-' + (n++); return x; };
for (const p of s.players) {
  const bf = p.battlefield.length ? p.battlefield : [];
  const gy = p.graveyard.length ? p.graveyard : bf;
  // wide boards: ~18 permanents each
  while (bf.length && p.battlefield.length < 18) p.battlefield.push(reid(bf[p.battlefield.length % bf.length]));
  // 40-card graveyards
  while (gy.length && p.graveyard.length < 40) p.graveyard.push(reid(gy[p.graveyard.length % gy.length]));
  // 12-card exile
  while (gy.length && p.exile.length < 12) p.exile.push(reid(gy[p.exile.length % gy.length]));
}
// 6-deep stack, if the capture had anything stackable
const src = s.players.flatMap(p => p.graveyard).slice(0, 6);
s.stack = src.map((c, i) => ({ ...clone(c), id: 'stack-' + i }));
fs.writeFileSync('./e2e/artifacts/layout-keyframe-fat.json', JSON.stringify(s, null, 2));
console.log('fat: bf', s.players.map(p=>p.battlefield.length).join('/'),
            'gy', s.players.map(p=>p.graveyard.length).join('/'),
            'stack', s.stack.length);
"
```

Expected output shows battlefields at 18, graveyards at 40, and a 6-card stack.

If the transform errors because a field is shaped differently than assumed (e.g. `stack` entries
are not plain cards), inspect the captured JSON and adjust — the capture is ground truth, this
script is a convenience.

- [ ] **Step 5: Build the harness route**

Create `client/src/dev/LayoutHarness.tsx`:

```tsx
// C5 layout harness (temporary — removed in Task 11). Mounts the real Game
// screen against a captured keyframe so the CSS pass can iterate in
// milliseconds instead of playing a game per tweak.
//
// #/layout      → the captured turn-12 board
// #/layout-fat  → the hand-fattened density ceiling

import { useEffect, useState } from 'react';
import { appStores } from '../app';
import type { GameState } from '../protocol/protocol';
import { Game } from '../ui/screens/Game';

export function LayoutHarness({ variant }: { variant: 'real' | 'fat' }) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const file = variant === 'fat' ? 'layout-keyframe-fat.json' : 'layout-keyframe.json';
    let cancelled = false;
    void fetch(`/@fs${new URL('.', import.meta.url).pathname}../../e2e/artifacts/${file}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((state: GameState) => { if (!cancelled) appStores.game.setState({ state }); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [variant]);

  if (error !== null) {
    return <main className="app"><p>layout fixture failed to load: {error}</p></main>;
  }
  return <Game />;
}
```

If the `/@fs` path proves awkward under this Vite version, the simpler alternative is to copy the
two JSON files into `client/public/` and fetch `/layout-keyframe.json` — do that instead and
remember to delete them in Task 11.

- [ ] **Step 6: Route to it**

In `client/src/ui/App.tsx`, add near the top of the `App` component's render — **before** the
`bumped` check so it bypasses connection state entirely:

```tsx
  if (import.meta.env.DEV && location.hash.startsWith('#/layout')) {
    return <LayoutHarness variant={location.hash === '#/layout-fat' ? 'fat' : 'real'} />;
  }
```

and the import:

```tsx
import { LayoutHarness } from '../dev/LayoutHarness';
```

- [ ] **Step 7: Verify the harness renders**

With `npm run dev` running, open `http://localhost:5173/#/layout` and `#/layout-fat`. Both should
render a populated four-seat board with no connection needed.

- [ ] **Step 8: Commit**

```bash
cd /home/ricardop/Projects/commander-night
git add client/src/app.ts client/src/dev/LayoutHarness.tsx client/src/ui/App.tsx \
        client/e2e/pw/capture-layout.spec.ts client/e2e/artifacts/
git commit -m "C5: temporary layout harness + captured keyframe fixtures

Removed in the C5 teardown task — this exists so the CSS pass is tuned
against a real turn-12 board and a hand-fattened density ceiling."
```

---

### Task 7: The large-screen scaling pass

**Files:**
- Modify: `client/src/styles.css`

**Interfaces:**
- Consumes: the `#/layout` and `#/layout-fat` routes (Task 6).
- Produces: a `--card-unit` custom property on `:root`; all `.card-*` widths expressed in terms of it.

**The problem, measured.** `.game` is `grid-template-columns: minmax(0, 1fr) 20rem` while every
card width is a fixed `rem` (`.card-bf: 5.6rem`, `.card-hand: 7.2rem`, `.card-grid: 8rem`,
`.card-small: 4rem`, `.card-preview: 16rem`). At 2560 px the board column takes ~2200 px and
renders ~90 px cards adrift in whitespace beside a sidebar that never grows. Extra screen buys
emptiness, not legibility.

- [ ] **Step 1: Capture the "before" screenshots**

```sh
cd client && npx playwright screenshot --viewport-size=1920,1000 \
  "http://localhost:5173/#/layout-fat" /tmp/claude-1000/-home-ricardop-Projects-commander-night/a2a6737d-1e50-4e03-927e-114cc725b295/scratchpad/before-1920.png
cd client && npx playwright screenshot --viewport-size=2560,1440 \
  "http://localhost:5173/#/layout-fat" /tmp/claude-1000/-home-ricardop-Projects-commander-night/a2a6737d-1e50-4e03-927e-114cc725b295/scratchpad/before-2560.png
```

If `npx playwright screenshot` is unavailable in this Playwright version, write a three-line
throwaway spec that does `page.goto` + `page.screenshot` at each viewport instead.

View both. Note specifically: how much horizontal whitespace the battlefield rows leave, and how
small the cards read relative to the window.

- [ ] **Step 2: Introduce the card unit**

In `client/src/styles.css`, add to the `:root` block (near the top, with the other custom
properties):

```css
  /* C5: card scale tracks viewport width. The table is 1080p and up, so the
     failure mode being designed against is an under-scaled board adrift in
     whitespace — not cramming. Floor keeps a 1280px window usable. */
  --card-unit: clamp(4.6rem, 3.1vw, 7.4rem);
```

Then replace the fixed card widths (currently around lines 253–257):

```css
.card-hand { width: calc(var(--card-unit) * 1.28); }
.card-bf { width: var(--card-unit); }
.card-small { width: calc(var(--card-unit) * 0.72); }
.card-grid { width: calc(var(--card-unit) * 1.42); }
.card-preview { width: calc(var(--card-unit) * 2.85); }
```

These multipliers preserve the existing ratios at the clamp's lower end (5.6rem base), so nothing
changes visually at small widths — the scaling is purely additive on large screens.

- [ ] **Step 3: Let the sidebar grow, and cap the board**

Replace the `.game` rule (currently around line 184):

```css
.game {
  flex: 1; min-height: 0;
  display: grid;
  /* C5: the log and chat are what benefit from a wide screen; the board does
     not need all of it. The sidebar grows with the viewport between bounds. */
  grid-template-columns: minmax(0, 1fr) clamp(20rem, 18vw, 30rem);
  gap: 0.6rem;
  padding-top: 0.5rem;
}

/* C5: ultrawide — stop the four seats stretching into a smear. */
.app-game { max-width: 2400px; margin: 0 auto; }
```

Note `.app-game` already sets `max-width: none` around line 180; this rule must come **after** it
to win, or edit that declaration in place instead of adding a second rule. Prefer editing in
place — two competing `max-width` declarations on one class is exactly the kind of thing that
confuses the next reader.

- [ ] **Step 4: Iterate against the harness**

Reload `#/layout-fat` at both viewports and tune the three clamp expressions until:

- the battlefield rows read as a board, not as small cards in a field of whitespace;
- the log/chat sidebar is comfortably readable at 2560 px;
- nothing overflows horizontally at 1920 px in the **fat** fixture (the density ceiling);
- `#/layout` (the real capture) still looks natural, not oversized.

Also check `1280×720` once — not a target, but the clamp floor should keep it functional rather
than broken.

- [ ] **Step 5: Capture the "after" screenshots and compare**

```sh
cd client && npx playwright screenshot --viewport-size=1920,1000 \
  "http://localhost:5173/#/layout-fat" /tmp/claude-1000/-home-ricardop-Projects-commander-night/a2a6737d-1e50-4e03-927e-114cc725b295/scratchpad/after-1920.png
cd client && npx playwright screenshot --viewport-size=2560,1440 \
  "http://localhost:5173/#/layout-fat" /tmp/claude-1000/-home-ricardop-Projects-commander-night/a2a6737d-1e50-4e03-927e-114cc725b295/scratchpad/after-2560.png
```

View before/after side by side and confirm the change is a real improvement, not just different.

- [ ] **Step 6: Verify no class names moved**

Run: `cd client && npm test`
Expected: PASS.

Then confirm the e2e selectors still exist:

```sh
cd client && grep -oE "\.[a-z-]+" e2e/pw/*.ts | sed 's/.*://' | sort -u > /tmp/sel.txt && \
  while read s; do grep -q -- "$s" src/styles.css src/ui/**/*.tsx 2>/dev/null || echo "MISSING $s"; done < /tmp/sel.txt
```

Expected: no `MISSING` lines for class selectors the specs rely on. Some entries will be file
extensions or false positives — check anything reported by hand rather than trusting the script.

- [ ] **Step 7: Commit**

```bash
cd /home/ricardop/Projects/commander-night
git add client/src/styles.css
git commit -m "C5: large-screen scaling pass

Card sizes now derive from a viewport-tracking --card-unit and the
sidebar grows with the window; the board is capped so ultrawide does not
stretch four seats into a smear. Tuned against the captured turn-12
board and the fattened density ceiling at 1920 and 2560."
```

---

### Task 8: Hover preview anchoring

**Files:**
- Modify: `client/src/ui/hover.ts`
- Modify: `client/src/ui/cards/HoverPreview.tsx`
- Modify: `client/src/styles.css`
- Modify: `client/src/ui/cards/CardView.tsx` (pass the anchor rect on hover)

**Interfaces:**
- Consumes: `hoverStore`, `hoverCard` from `src/ui/hover.ts`.
- Produces: `hoverCard(card: Card | undefined, anchor?: { x: number; y: number })` — the second parameter is the hovered element's viewport-centre point; `HoverState` gains `anchor?: { x: number; y: number }`.

**The problem.** The preview is `position: fixed; left: 0.8rem; bottom: 0.8rem` at a fixed
`16rem`. On a 2560 px screen it is a long eye-trip from the hovered card and it can cover the
prompt dock.

**Already fine — verify, do not "fix".** `.hover-preview` is `z-index: 200` and
`.modal-backdrop` is `z-index: 100`, so hovering inside a pile browser already previews above the
modal. Confirm this by hand; only change it if it is actually broken.

- [ ] **Step 1: Carry an anchor on the hover store**

Replace `client/src/ui/hover.ts`:

```ts
// Hover-preview state — ephemeral view state (not protocol state, so outside
// the design-§4 store table): the card currently hovered anywhere a card
// appears (§9). One global preview panel reads it.
//
// C5 adds the anchor: the hovered element's viewport centre, so the preview
// can appear beside what you are pointing at instead of in a fixed corner
// half a screen away on a 1440p display.

import { createStore } from 'zustand/vanilla';
import type { Card } from '../protocol/protocol';

export interface HoverAnchor { x: number; y: number }

export interface HoverState { card?: Card; anchor?: HoverAnchor }

export const hoverStore = createStore<HoverState>(() => ({}));

export const hoverCard = (card: Card | undefined, anchor?: HoverAnchor) =>
  hoverStore.setState({ card, anchor });
```

- [ ] **Step 2: Supply the anchor from the card element**

Run: `cd client && grep -n "hoverCard" src/ui/cards/CardView.tsx`

At each `onMouseEnter` that calls `hoverCard(card)`, pass the element's centre:

```tsx
onMouseEnter={e => {
  const r = e.currentTarget.getBoundingClientRect();
  hoverCard(card, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
}}
```

Leave the `onMouseLeave` handler calling `hoverCard(undefined)` as it is.

If `hoverCard` is also called from other components, update those call sites the same way; a
missing anchor is handled by the fallback in Step 3, so partial coverage degrades rather than
breaks.

- [ ] **Step 3: Position the preview beside the anchor**

Replace `client/src/ui/cards/HoverPreview.tsx`:

```tsx
// The enlarged hover preview (§9): image when resolved, text frame as the
// preview body when not. One global instance fed by the hover store.
//
// C5: anchored beside the hovered card rather than pinned to a fixed corner —
// on a 1440p board the corner was half a screen away and could sit on top of
// the prompt dock. Flips side and clamps vertically to stay on-screen; falls
// back to the old lower-left position when no anchor is supplied.

import { useStore } from 'zustand';
import { appScryfall } from '../../app';
import { hoverStore } from '../hover';
import { TextFrame } from './CardView';

const GAP = 16;          // px between the hovered card and the preview
const MARGIN = 12;       // px kept clear of every viewport edge

export function HoverPreview() {
  const card = useStore(hoverStore, s => s.card);
  const anchor = useStore(hoverStore, s => s.anchor);
  const image = useStore(appScryfall.store, s => (card !== undefined ? s.images[appScryfall.keyOf(card)] : undefined));
  if (card === undefined) return null;

  // Width must match .hover-preview's computed width; --card-unit * 2.85 at
  // the clamp ceiling is ~21rem, so 360px is a safe layout assumption here.
  const style: React.CSSProperties = {};
  if (anchor !== undefined && typeof window !== 'undefined') {
    const w = 360;
    const h = Math.round(w * 88 / 63) + 120;      // card aspect + oracle text
    const preferRight = anchor.x < window.innerWidth / 2;
    const left = preferRight ? anchor.x + GAP : anchor.x - GAP - w;
    style.left = `${Math.min(Math.max(left, MARGIN), window.innerWidth - w - MARGIN)}px`;
    style.top = `${Math.min(Math.max(anchor.y - h / 2, MARGIN), Math.max(MARGIN, window.innerHeight - h - MARGIN))}px`;
    style.bottom = 'auto';
  }

  return (
    <div className="hover-preview" style={style}>
      {image?.status === 'ok'
        ? <img src={image.url} alt={card.name} />
        : <TextFrame card={card} size="preview" />}
      {image?.status === 'ok' && card.text.length > 0 && (
        <div className="hover-oracle">{card.text.map((l, i) => <p key={i}>{l}</p>)}</div>
      )}
    </div>
  );
}
```

Add the `React` type import if `tsc` complains about `React.CSSProperties`:

```tsx
import type { CSSProperties } from 'react';
```
and use `CSSProperties` instead of `React.CSSProperties`.

- [ ] **Step 4: Update the preview's CSS**

In `client/src/styles.css`, replace the `.hover-preview` rule (around line 451):

```css
.hover-preview {
  /* left/top are supplied inline from the hover anchor; these are the
     no-anchor fallback (C5). pointer-events:none so the preview never eats a
     click meant for the card under it. */
  position: fixed; left: 0.8rem; bottom: 0.8rem; z-index: 200;
  width: calc(var(--card-unit) * 2.85);
  pointer-events: none;
}
```

- [ ] **Step 5: Verify by hand**

With `npm run dev` and `#/layout-fat` open at 2560×1440:

- hover cards near the left edge → preview appears to the right;
- hover cards near the right edge → preview flips to the left;
- hover cards at the very top and very bottom → preview stays fully on-screen;
- open a graveyard browser and hover a card in it → preview renders **above** the modal;
- the preview never blocks a click.

- [ ] **Step 6: Run the suite**

Run: `cd client && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/ricardop/Projects/commander-night
git add client/src/ui/hover.ts client/src/ui/cards/HoverPreview.tsx \
        client/src/ui/cards/CardView.tsx client/src/styles.css
git commit -m "C5: anchor the hover preview beside the hovered card

Flips side and clamps to the viewport; scales with --card-unit. The
fixed lower-left corner was half a screen away at 1440p and could cover
the prompt dock."
```

---

### Task 9: Built-bundle smoke test

**Files:**
- Modify: `client/src/app.ts` (harness gate)
- Modify: `client/package.json` (scripts)
- Create: `client/playwright.preview.config.ts`

**Interfaces:**
- Consumes: the existing `autoplayer.spec.ts` and `driver.ts`, unchanged.
- Produces: `npm run build:harness` and `npm run preview:harness` scripts; a Playwright config with `baseURL: http://localhost:4173`.

**The problem this exists to catch, and the blocker it hits.** The production bundle has never
been exercised — every green test so far ran against the Vite dev server. But `window.__night` is
gated on `import.meta.env.DEV`, which is **false** in a production build, so `driveGame` would
immediately throw `window.__night missing — not a dev build?`.

The fix is a separate opt-in flag so the harness can be built into a *smoke* bundle while the
real production build stays clean. `npm run build` (used for the actual deploy in Task 10) never
sets it.

- [ ] **Step 1: Gate the harness on DEV or an explicit flag**

In `client/src/app.ts`, change the dev-handle guard:

```ts
// The auto-player handle ships in dev, and in an explicitly-flagged build so
// the C5 smoke tier can drive the real production bundle. `npm run build` —
// the deploy path — never sets VITE_NIGHT_HARNESS, so prod has no handle.
const HARNESS = import.meta.env.DEV || import.meta.env.VITE_NIGHT_HARNESS === '1';

if (HARNESS && typeof window !== 'undefined') {
```

- [ ] **Step 2: Add the scripts**

In `client/package.json`, add to `scripts`:

```json
    "build:harness": "vite build --mode harness",
    "preview:harness": "vite preview --port 4173",
    "test:preview": "playwright test -c playwright.preview.config.ts"
```

Create `client/.env.harness`:

```
VITE_NIGHT_HARNESS=1
```

Vite loads `.env.harness` for `--mode harness`, so the flag applies to that build only.

- [ ] **Step 3: Add the preview Playwright config**

Create `client/playwright.preview.config.ts`:

```ts
// C5 built-bundle smoke: the C3 auto-player, run against the real production
// bundle instead of the dev server. This is the only tier that exercises the
// built output — tree-shaking, env resolution, and asset paths all differ from
// dev, and the night runs on the built bundle.
//
// Assumes XMage + bridge are running, plus `npm run preview:harness`.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/pw',
  testMatch: 'autoplayer.spec.ts',
  timeout: 240_000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:4173',
  },
});
```

- [ ] **Step 4: Confirm the preview server proxies the bridge**

`vite preview` does **not** apply the dev-server proxy from `vite.config.ts`, so `/ws` would 404
and the client would never connect. Add a preview proxy to `client/vite.config.ts` alongside the
existing `server` block:

```ts
  preview: {
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8484', ws: true },
    },
  },
```

This mirrors what caddy does in production (Task 10) — the built bundle derives
`ws://localhost:4173/ws` from its own origin, exactly as it will derive `wss://host/ws` on the
VPS.

- [ ] **Step 5: Build and run the smoke**

With XMage and the bridge running:

```sh
cd client && npm run build:harness && npm run preview:harness &
cd client && npm run test:preview
```

Expected: the auto-player plays a full game to `game.over` against the production bundle, with
the same assertions as the dev-server run (≥1 combat declaration, no dead-end prompts).

Note two expected differences from the dev run, neither a failure: `devVerify` is off in a built
bundle, so `counters.verifies` stays 0 and `divergences` is trivially 0; and `strictDecode` is
off, so an unknown field would be tolerated rather than thrown. Both are correct production
behaviour.

- [ ] **Step 6: Verify the real production build has no harness**

```sh
cd client && npm run build && grep -c "__night" dist/assets/*.js
```

Expected: `0` — the deploy bundle carries no auto-player handle. If it reports a match, the gate
in Step 1 is wrong; fix it before continuing, because that bundle is what ships.

- [ ] **Step 7: Commit**

```bash
cd /home/ricardop/Projects/commander-night
git add client/src/app.ts client/package.json client/playwright.preview.config.ts \
        client/vite.config.ts client/.env.harness
git commit -m "C5: smoke the real production bundle with the auto-player

window.__night is DEV-gated, so the built bundle was untestable; add an
explicit VITE_NIGHT_HARNESS build mode for the smoke tier. npm run build
— the deploy path — still ships no harness."
```

---

### Task 10: Deploy the client behind caddy

**Files:**
- Modify: `deploy/Caddyfile`
- Modify: `deploy/README.md`

**Interfaces:**
- Consumes: `client/dist/` from `npm run build` (Task 9 Step 6 verified it is harness-free).
- Produces: a caddy config serving the SPA at `/` and proxying `/ws` to the bridge; runbook steps for shipping and re-shipping the client.

**Confirmed, not assumed:** the client derives `wss://{location.host}/ws` from the page origin
(`src/app.ts`), Vite's dev proxy forwards `/ws` unrewritten, and the bridge accepts that path —
so dev, preview, and production all present the bridge with the same path. Routing is hash-based
(`#/join`), so there are no history-API rewrites to get right.

- [ ] **Step 1: Split the Caddyfile**

Replace the `night.example.com { … }` block in `deploy/Caddyfile`:

```
night.example.com {
	# ACME via DNS-01: issuance never depends on inbound port 80. Needs a
	# caddy binary with the route53 plugin and AWS creds in caddy's
	# environment — see "TLS via DNS-01" in the README. Drop this tls
	# block to fall back to HTTP-01 on a plain caddy build.
	tls {
		dns route53
	}

	# The bridge owns exactly one path; everything else is the static client.
	# The browser derives this URL from its own origin (client src/app.ts), so
	# there is no build-time host configuration anywhere.
	handle /ws* {
		reverse_proxy 127.0.0.1:8484
	}

	handle {
		root * /opt/commander-night/client
		# Vite emits content-hashed asset filenames, so /assets/* can cache
		# forever. index.html must NOT: without this, pushing a fix mid-night
		# leaves every browser on the previous bundle with no way to know.
		@assets path /assets/*
		header @assets Cache-Control "public, max-age=31536000, immutable"
		header /index.html Cache-Control "no-cache"
		try_files {path} /index.html
		file_server
	}
}
```

- [ ] **Step 2: Add the client to the runbook's install section**

In `deploy/README.md`, in the `## Install` code block, add after step 4 (the bridge build/ship)
and renumber the following steps:

```sh
# 5. build + ship the web client (on the dev machine)
cd client && npm ci && npm run build
rsync -a --delete dist/ vps:/opt/commander-night/client/
```

- [ ] **Step 3: Document the two gotchas**

Add a new section to `deploy/README.md`, after the "TLS via DNS-01" section:

````markdown
## The web client

Caddy serves the built SPA at `/` and proxies only `/ws` to the bridge
(`deploy/Caddyfile`). The browser derives its WebSocket URL from the page
origin, so there is no host baked into the bundle — the same `dist/` works on
any hostname.

**SELinux.** On Rocky/EL with SELinux enforcing, caddy cannot read a
`file_server` root under `/opt` until it is labelled, and the failure is a
silent 403 rather than an error in caddy's log:

```sh
sudo semanage fcontext -a -t httpd_sys_content_t "/opt/commander-night/client(/.*)?"
sudo restorecon -Rv /opt/commander-night/client
```

(`semanage` comes from `policycoreutils-python-utils`.) Verify with
`curl -I https://your.host/` — a 403 with an empty caddy error log is almost
always this.

**Client and bridge redeploy independently.** They are separate artifacts:

| Changed | Redeploy |
|---|---|
| anything under `client/` | rebuild + rsync `dist/`; no service restart — caddy serves from disk |
| anything under `bridge/` | rebuild + rsync the jar, then `systemctl restart night-bridge` (drops live seats) |
| `deploy/Caddyfile` | `systemctl reload caddy` |

Because `index.html` is served `no-cache`, a client redeploy reaches players
on their next page load. A hard refresh is never required — and if you find
yourself telling someone to hard-refresh, the cache headers are wrong.
````

- [ ] **Step 4: Validate the Caddyfile syntax**

```sh
cd /home/ricardop/Projects/commander-night && caddy validate --config deploy/Caddyfile --adapter caddyfile
```

Expected: `Valid configuration`. If caddy is not installed locally, skip — it is validated on the
VPS at deploy time by `systemctl reload caddy` failing loudly.

- [ ] **Step 5: Commit**

```bash
cd /home/ricardop/Projects/commander-night
git add deploy/Caddyfile deploy/README.md
git commit -m "C5: serve the web client from caddy

Split the blanket reverse_proxy into /ws → bridge and everything else →
static SPA, with immutable asset caching and no-cache index.html so a
mid-night fix actually reaches players. Documents the SELinux label and
the client/bridge redeploy split."
```

---

### Task 11: Teardown, documentation, and the deploy run

**Files:**
- Delete: `client/src/dev/LayoutHarness.tsx`, `client/e2e/pw/capture-layout.spec.ts`, `client/e2e/artifacts/layout-keyframe.json`, `client/e2e/artifacts/layout-keyframe-fat.json`
- Modify: `client/src/ui/App.tsx` (remove the `#/layout` route), `client/src/app.ts` (remove `dumpState`)
- Modify: `docs/client/design.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a client with no harness surface, and docs that match reality.

- [ ] **Step 1: Remove the layout harness**

```sh
cd /home/ricardop/Projects/commander-night
rm client/src/dev/LayoutHarness.tsx client/e2e/pw/capture-layout.spec.ts
rm client/e2e/artifacts/layout-keyframe.json client/e2e/artifacts/layout-keyframe-fat.json
```

Then remove from `client/src/ui/App.tsx`: the `LayoutHarness` import and the
`if (import.meta.env.DEV && location.hash.startsWith('#/layout'))` block.

And from `client/src/app.ts`: the `dumpState` entry in the dev handle and the `dumpState(): unknown;`
line in the `declare global` block.

(If Step 5 of Task 6 fell back to `client/public/*.json`, delete those too.)

- [ ] **Step 2: Verify nothing references the harness**

```sh
cd client && grep -rn "LayoutHarness\|dumpState\|layout-keyframe" src/ e2e/ test/ || echo "clean"
```
Expected: `clean`.

- [ ] **Step 3: Run the full suite**

Run: `cd client && npm test`
Expected: PASS — including the new `deck`, `nudge`, and `pile` suites.

- [ ] **Step 4: Run both live e2e specs against the dev server**

With XMage, bridge, and `npm run dev` running:

```sh
cd client && npx playwright test
```
Expected: `autoplayer.spec.ts` and `resilience.spec.ts` both green — proof the layout and hover
changes did not break the DOM contract the driver depends on.

- [ ] **Step 5: Update the client design doc**

In `docs/client/design.md`, replace the C5 row in the §14 milestone table:

```markdown
| C5 ✅ | Friends'-night readiness: deck-text image warm-up, large-screen layout pass, hover-preview anchoring, pile filter/sort, background-tab title-flash nudge, prod build served by caddy | **The real 4-human night on the deployed host** — the same event as bridge M5's outstanding exit; both docs close together |
```

Add below the table:

```markdown
**C5 scope revisions (2026-07-19).** Two items shifted against the real table.
The layout pass targets **1080p and 1440p+**, not laptops: every screen at the
table is an external monitor, so the failure mode designed against was an
under-scaled board adrift in whitespace, not cramming — fixed cards sizes were
replaced by a viewport-tracking `--card-unit`. And the nudge is **title flash
only**; the chime was cut, taking the audio asset, the autoplay unlock, and a
settings toggle with it. The layout pass was tuned against a captured turn-12
keyframe and a hand-fattened density ceiling through a temporary `#/layout`
harness, removed at the end of the milestone.

**New at C5: the built bundle is tested.** Every tier through C4 ran against the
Vite dev server, and `window.__night` is `DEV`-gated — so the production bundle,
the thing that actually ships, had never been driven. `npm run test:preview`
runs the auto-player against a `--mode harness` build (`playwright.preview.config.ts`);
`npm run build`, the deploy path, still emits no harness.
```

- [ ] **Step 6: Update CLAUDE.md**

Replace the `**Status:**` paragraph's opening sentence so it leads with C5, and note what remains.
Keep the existing C4 detail — it documents live-learned bugs that are still relevant. Add:

```markdown
**Status:** Client C5 engineering done 2026-07-19 — deck-text image warm-up (own deck only:
opponents' lists are hidden info), large-screen layout pass (`--card-unit` scales cards and the
sidebar with the viewport; the table is 1080p/1440p+, so the enemy was whitespace, not cramming),
anchored hover previews, pile filter/sort/Escape, and a background-tab title-flash nudge (the
chime was cut). The production bundle is now exercised for the first time: `npm run test:preview`
drives the auto-player against a `--mode harness` build, and caddy serves `dist/` at `/` with
`/ws` proxied to the bridge (immutable assets, `no-cache` index.html). **Remaining for both
C5 and bridge M5: the real 4-human night on the deployed host.**
```

- [ ] **Step 7: Commit the docs**

```bash
cd /home/ricardop/Projects/commander-night
git add -A client/src client/e2e docs/client/design.md CLAUDE.md
git commit -m "C5: remove the layout harness; document the milestone

Harness, capture spec, and both fixtures deleted as planned. Records the
two scope revisions (large-screen target, chime cut) and the new
built-bundle smoke tier."
```

- [ ] **Step 8: Deploy to the VPS and smoke it**

Follow `deploy/README.md`:

```sh
cd client && npm ci && npm run build
rsync -a --delete dist/ vps:/opt/commander-night/client/
# merge the new deploy/Caddyfile handle blocks into /etc/caddy/Caddyfile
ssh vps 'sudo systemctl reload caddy'
```

Then verify in a browser at `https://night.example.com`:

- the home screen loads and the status reads `connected` (proves `/ws` proxying works);
- `curl -I https://night.example.com/` returns 200, not 403 (if 403, apply the
  SELinux label from the runbook);
- `curl -sI https://night.example.com/ | grep -i cache-control` shows
  `no-cache`;
- create a lobby, submit a deck, start with AI fill, and play a few turns — including one turn
  where you background the tab on your priority and confirm the title flashes.

- [ ] **Step 9: Report status**

C5 engineering is complete at this point. The milestone's exit criterion — the real 4-human
night on the deployed host, shared with bridge M5 — is Ricardo's to run. Report what was
verified and what is left, without claiming the milestone is closed.

---

## Deferred, deliberately

- **Bridge-side post-game chat fan-out** (C4 finding). Out of scope per the spec; still open.
- **Mobile layout, DFC both-faces preview, semantic move animation, spectators** — post-C5 / v2
  per `docs/client/design.md` §16.
- **Opponent-deck image warm-up** — decklists are hidden info; opponents' cards resolve on first
  sight at battlefield priority.
