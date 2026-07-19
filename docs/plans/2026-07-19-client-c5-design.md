# Client C5 — friends'-night readiness (design)

**Date:** 2026-07-19 · **Milestone:** client C5 (`docs/client/design.md` §14)
**Exit criterion:** the real 4-human night on the deployed host — the same event as bridge M5's
outstanding exit. This spec takes the client to *deployed and smoke-tested*; the night itself is
a human step.

## 0. Scope, and two revisions to the §14 C5 line

C5 as written in `docs/client/design.md` §14 is: image cache warm-up, layout pass at common
laptop sizes, hover previews and pile browsers polished, notification nudge when priority
arrives in a background tab (title flash + optional chime), prod build wired into `deploy/`.

Two revisions, both decided 2026-07-19:

1. **"Layout pass at common laptop sizes" → large-screen pass.** The actual table is 1080p
   externals and 1440p/ultrawide. There is no 13" laptop. The failure mode to design against is
   therefore a sparse, under-scaled board adrift in whitespace — not cramming. This inverts the
   assumption the §14 line was written under.
2. **"title flash + optional chime" → title flash only.** The chime is cut: no bundled audio
   asset, no autoplay-unlock dance, no settings toggle.

Sequencing: all four client items first, deploy last. The deploy is the only item that gates the
night, but polishing against a real session's feedback was traded away deliberately in favour of
the night happening on a finished client.

**Out of scope.** The bridge-side post-game chat fan-out left open at C4 (`docs/client/design.md`
§15) stays open and tracked. C5 is client-only.

## 1. Image cache warm-up

**Problem.** On a cold cache the first turns are a slideshow: images resolve only as cards become
visible, paced at Scryfall's ~8 req/s courtesy limit.

**Design.** On deck submit, parse the session's persisted deck text for card identities and queue
every one through the existing resolver at priority 2 (piles — lowest, so live gameplay lookups
still preempt them).

The `.dck` format is `1 [SET:NUMBER] Name`, which is exactly the `set` + `collectorNumber`
identity `images/scryfall.ts` keys on — no guessing, no name-only fallback needed for the warm
path. New code is confined to:

- a `.dck` → `CardIdentity[]` parser (new, unit-tested);
- one call in `submitDeckFlow` (`net/actions.ts`).

Everything else — the lookup ladder, the paced queue, dedupe, the memory + `cn.imageCache`
localStorage layers — is reused unchanged. ~100 cards ≈ 13 s of lobby idle on a cold cache, and
near-zero on subsequent nights.

**Deliberately not done.** Opponents' cards are not warmed: their decklists are hidden info and
the bridge does not send them. They resolve on first sight at battlefield priority, which is the
current behaviour and is adequate once localStorage is warm. A build-time pre-seeded cache of the
group's four decks was considered and rejected — it couples the build to specific decklists and
goes stale on any deck edit.

## 2. Layout pass (large screens)

**Problem, measured from the current CSS.** Two compounding issues:

- `.game` is `grid-template-columns: minmax(0, 1fr) 20rem`. At 2560 px the board column takes
  ~2200 px while the sidebar stays pinned at 20rem regardless of available width.
- Every card size is a fixed `rem` — `.card-bf` is `5.6rem` (~90 px), `.card-hand` `7.2rem`,
  `.card-preview` `16rem`. Nothing scales with the viewport.

Together these mean additional screen width buys emptiness rather than legibility: a late-game
board renders as small cards adrift in whitespace next to a sidebar that never grows.

**Design.**

- Introduce a root `--card-unit` custom property driven by `clamp()` against viewport width.
  Express all `.card-*` widths as multiples of it, so card scale tracks the screen.
- Let the sidebar grow at a second breakpoint. The log and chat are the panels that genuinely
  benefit from more room; the board does not need all of it.
- Cap total board width so ultrawide does not stretch the four seats into a smear.

**Constraint:** the Playwright driver selects on class names. Change sizing and positioning;
leave the class structure intact. This is what keeps `autoplayer.spec.ts` and
`resilience.spec.ts` green through the pass.

**Evidence.** No realistic mid-game state exists offline — the largest committed keyframe sample
(`docs/protocol/samples/game.state.json`, 2 KB) is turn-1 shaped and useless for a density pass.
So:

1. One live auto-player run with the existing recorder (`dev/recorder.ts`) captures a real
   turn-15+ keyframe. Commit it as a layout fixture.
2. Hand-fatten a second variant to worst case: ~40-card graveyards, 6-deep stack, wide boards,
   long log.
3. A dev-only `#/layout` route mounts the `Game` screen against either fixture.
4. Screenshot at **1920×1000** and **2560×1440**; tune against real evidence plus a tunable
   density ceiling.

**The route and both fixtures are deleted at the end of C5.** They exist to do the pass, not to
ship. Future layout work re-derives its own evidence.

## 3. Hover previews and pile browsers

**Hover preview** (`ui/cards/HoverPreview.tsx`) is one global panel pinned to the lower-left at a
fixed `16rem`. Three problems on a large screen: it is a long eye-trip from the hovered card, it
can sit on top of the prompt dock, and it does not scale with the viewport.

Design: anchor the preview near the hovered card, flipping horizontal side and vertical
alignment as needed to stay on-screen; size it from `--card-unit`; ensure it stacks above modals
so hovering *inside* a pile browser previews correctly.

**Pile browsers** (`ui/board/Modal.tsx`, opened from `SeatPanel`) render a flat `CardGrid` with
no sort and no filter. A 40-card graveyard is a wall scanned by eye. Design: a filter box matching
`Card.name`, a sort over `Card.types` then `Card.manaValue` (both already on the protocol type —
no new server fields), and `Escape` to close (currently backdrop-click only).

## 4. Background-tab priority nudge

**Design.** When a `priority` prompt arrives while `document.hidden`, alternate `document.title`
between the real title and `● Your turn`. Stop and restore on `visibilitychange` (tab
foregrounded) or when the prompt resolves.

Lives in a small `ui/nudge.ts` subscribing to the prompt store, with `document` injected so it is
testable headlessly. No permissions, no audio, no settings surface — title flash was chosen as
the whole feature, not as a baseline layer beneath a chime.

## 5. Prod build and deploy

**Build.** `npm run build` → `client/dist/`. `VITE_BRIDGE_WS` stays unset in production so
`app.ts` derives `wss://{location.host}/ws` from the page origin: same-origin, no CORS, no env
file. Hash routing (`#/join`) means there are no server-side route rewrites to get right.

**Caddy.** The committed `deploy/Caddyfile` proxies *everything* to the bridge, which would
swallow a static site. It splits:

```
handle /ws* { reverse_proxy 127.0.0.1:8484 }
handle {
    root * /opt/commander-night/client
    try_files {path} /index.html
    file_server
}
```

Dev's Vite proxy forwards `/ws` unrewritten (`vite.config.ts`), so the bridge sees the same path
in both tiers. **Verify this against the bridge's actual WS path handling rather than assuming
it** — nothing in `bridge.yaml` configures a path.

**Cache headers.** Vite emits content-hashed files under `/assets/`, which can be cached
immutably. `index.html` must be served `no-cache`. Without this, a mid-night fix ships and every
browser keeps running the previous bundle with no signal that it is stale.

**Two runbook gotchas.**

- SELinux on Rocky (enforcing) will block caddy's `file_server` from reading a root under
  `/opt` unless the directory is labelled for it. Silent 403s otherwise.
- Redeploying the client is now a step distinct from redeploying the bridge. The runbook must say
  so explicitly, including which of the two a given change requires.

## 6. Testing

| Tier | What |
|---|---|
| Unit (vitest) | `.dck` identity parser: commander and sideboard lines, malformed lines, dedupe of repeated identities. Nudge state machine against an injected `document` stub: hidden→flash, visible→restore, prompt-resolved→restore, no flash while foregrounded |
| Regression | `autoplayer.spec.ts` and `resilience.spec.ts` stay green across the layout pass — the reason §2 constrains changes to sizing/positioning and preserves class names |
| Built-bundle smoke (new) | The autoplayer spec run against `vite preview` — the real production build — rather than the dev server. The only tier that catches build-only breakage (tree-shaking, env resolution, asset paths) before the night |
| Layout | Screenshots at 1920×1000 and 2560×1440, reviewed by eye. No visual-regression baselines: brittle, and disproportionate for a one-time pass |

The nudge is deliberately not covered in e2e — backgrounding a real tab is not reliably drivable
from Playwright, and a test that fakes `document.hidden` through the browser tests less than the
headless one does.

## 7. Documentation

- `docs/client/design.md` §14 — C5 row: large-screen pass, chime cut, and the outcome.
- `deploy/README.md` — client build/ship/redeploy step, the SELinux label, the cache headers, and
  the bridge-vs-client redeploy distinction.
- `deploy/Caddyfile` — the handle split.
- `CLAUDE.md` — status line.

## 8. What C5 does not close

- **The night itself.** C5 delivers a client deployed and smoke-tested on the VPS. The 4-human
  session is the exit criterion for both this milestone and bridge M5, and both docs close on
  that same event.
- **Post-game chat.** Still dead upstream on 1.4.60 (C4 finding). The bridge-side fan-out remains
  the open fix.
- **Mobile layout, DFC both-faces preview, semantic move animation, spectators** — all remain
  post-C5 / v2 per `docs/client/design.md` §16.
