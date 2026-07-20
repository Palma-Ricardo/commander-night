# Multi-format deck import — design

**Date:** 2026-07-20
**Status:** approved, pending implementation plan
**Touches:** `docs/protocol/v1.md` §5, `docs/bridge/design.md` §9 + §15, `bridge/` lobby package,
`client/src/net`, `deploy/`

## 1. Problem

`lobby.deck` accepts exactly one syntax: XMage's `.dck` (`N [SET:NUM] Name`, `SB:` marks the
commander). Nothing else parses — `format:'list'` is declared in the protocol but rejected at
`LobbyService.java:220`.

Commander Night exists to replace a scripted Tabletop Simulator table. That table's importer
accepts MTGO syntax, and the group builds decks on Moxfield. Requiring a hand-built `.dck`
per player per night is the friction that keeps people on TTS.

Three syntaxes must work:

| Format | Shape | Commander | Notes |
|---|---|---|---|
| `.dck` | `1 [MKC:145] Agitator Ant` | `SB:` lines | XMage-native, already supported |
| `.moxfield` | `1 Agitator Ant (MKC) 145 *F*` | **first one or two lines** | optional trailing sections |
| `.mtgo` | `1 Agitator Ant` | **last stanza** | no set/number — must be derived |

## 2. Findings that shape the design

Established by reading `vendor/mage` at 1.4.60:

- **XMage never sees our text.** `DeckParser` builds a `DeckCardLists` and `TableRecipe.java:85`
  passes that object to `joinTable`. XMage's own `.dck` file parser is never invoked, so our
  parsers are the *only* syntax gate. There is no fallback validation behind us.
- **Cards are looked up by set + number only.** `Deck.java:150` → `CardRepository.findCard(setCode,
  cardNumber)`. The card name in a `DeckCardInfo` is decorative — a wrong name imports silently,
  a wrong set/number throws `GameException` at `joinTable`, surfacing as an opaque
  `"table setup failed at step: joinTable <user>"` well after the lobby said the deck was valid.
- **Matching is case-insensitive.** `DatabaseUtils.java:33` sets `IGNORECASE=TRUE` on the
  connection. Only the *format* of a set code or number has to be right, not its case.
- **XMage resolves `.mtgo` names but mis-structures real files.** `TxtDeckImporter` resolves bare
  names with `findPreferredCoreExpansionCard` (`CardRepository.java:431` — newest standard-legal
  printing, else newest release), which we reuse. But its structural rule is
  `switchSideboardByEmptyLine` (`TxtDeckImporter.java:26`): *everything* after the **first** blank
  line becomes sideboard, and a **second** blank line is an error
  (`"but sideboard already used"`, line 69). Two of the three sample decks have two blank lines,
  so XMage's own importer would put a `PLANES:` or `SIDEBOARD:` section into the commander zone
  and warn. We therefore cannot delegate structure to it — only name resolution.
- **XMage cannot do `.moxfield`.** `TxtDeckImporter` never parses `(SET) NUM`; it would treat
  `Inspirit, Flagship Vessel (EOC) 2 *F*` as a literal card name and miss. Its only sideboard
  header is `//sideboard`, not `SIDEBOARD:`. This matches the observed behavior.
- **The card DB is concurrently openable.** `DatabaseUtils.java:32` sets `AUTO_SERVER=TRUE` (H2
  mixed mode), so a second JVM may open `db/cards.h2` while the game server holds it.

## 3. Decision: live `CardRepository`, not a generated index

`docs/bridge/design.md:267` planned a `cards-index.tsv` scraped offline from `Mage.Sets` sources.
**Superseded.** The bridge queries the pinned server's own card database at runtime.

Rationale: the index approach requires reimplementing preferred-printing selection, split/DFC name
handling, and accent normalization — precisely where import bugs hide — and carries a standing
drift risk (`design.md:374`) plus a regeneration step on every version bump. Live lookup is the
same code XMage itself runs, so our printing choices match its client's by construction, and
`design.md:374`'s risk entry is deleted rather than mitigated.

Cost accepted: H2 reserves a 150 MB query cache (`DatabaseUtils.java:43`). Against the host's
8 GiB this is noise.

## 4. Architecture

`DeckParser` (one class) becomes a package under `night.bridge.lobby.deck`. The seam is drawn so
that everything except one class is pure string work with no database dependency:

```
                    text + format:'auto'
                             |
                     DeckFormat.sniff()          -> dck | moxfield | mtgo
                             |
        DckLines / MoxfieldLines / MtgoLines     -> List<DeckLine>   (pure, unit-testable)
                             |
                       CardResolver              -> List<Resolved>   (the only DB consumer)
                             |
                      DeckAssembler              -> DeckCardLists + DeckInfo
```

**`DeckLine`** — `record DeckLine(int qty, String name, String setCode, String number,
Section section, int lineNo)`, where `setCode`/`number` are nullable and `Section` is
`MAIN | COMMANDER | MAYBE_COMMANDER | DISCARD`. This is the common currency; the three line
parsers differ only in how they populate it.

`MAYBE_COMMANDER` exists because of partners. `.dck` and `.mtgo` mark commanders unambiguously
from text alone (`SB:` prefix; the last stanza), but `.moxfield` needs the card database to
tell a partner pair from a commander followed by an ordinary card — and the line parsers are
deliberately database-free. So `MoxfieldLines` marks line 1 `COMMANDER` and line 2
`MAYBE_COMMANDER`, and `DeckAssembler` promotes or demotes line 2 *after* `CardResolver` has run.
That keeps the one impure step in one class.

**`DeckFormat.sniff(String)`** — classifies on line shape, which is mutually exclusive across the
three formats:

- a line matching `^(SB:)?\s*\d+\s+\[[^:\]]+:[^\]]+]` or starting `LAYOUT` → `dck`
- a line matching `\(\w+\)\s+\S+\s*(\*F\*)?$` → `moxfield`
- otherwise, if any line matches `^\d+\s+\S` → `mtgo`
- no card-shaped line at all → error, `"cannot tell what format this is"`

Classification is a majority vote over card-shaped lines, not first-match, so one malformed line
does not flip the verdict.

**Commander and section assignment**, per format:

Both Moxfield-produced formats share one grammar: blank-line-delimited **stanzas**, where a stanza
whose first line is a bare `HEADER:` (`SIDEBOARD:`, `PLANES:`) is a named extra section. They
differ only in where the commanders sit — and in whether card lines carry `(SET) NUM`.

Verified across all six sample files:

| Format | `COMMANDER` | `DISCARD` |
|---|---|---|
| `dck` | `SB:` lines | — |
| `mtgo` | the **last stanza** — structural, 1 or 2 lines | any `HEADER:` stanza |
| `moxfield` | the first **one or two** lines of stanza 1 (see below) | any `HEADER:` stanza |

Moxfield lines carry a trailing foil marker (`*F*`) which is stripped and ignored. It is **not** a
commander marker — the samples carry it on `Inspirit, Flagship Vessel` (a commander, line 1),
`Kilo, Apogee Mind` (a regular card, mid-list), and on *both* lines of the Timey-Wimey partner
pair. Nothing in the file distinguishes a commander except position.

### Headered sections are discarded

The samples contain `SIDEBOARD:` (25 cards) and `PLANES:` (10 cards). Neither belongs in an XMage
Commander deck: XMage has no Commander sideboard — it uses that zone for the commander — and
`Commander Free For All` is not Planechase. Including either would blow the 100-card count.

Note these are **not** always trailing: in `.mtgo` the section sits *between* the main list and the
commander stanza. The rule is therefore positional-free — **any stanza opening with a bare
`HEADER:` line is discarded**, wherever it appears. Rather than enumerate names, unknown future
sections degrade to "ignored" instead of "unparseable". Each is **reported**, named and counted:
`"ignored 10 cards in section PLANES:"`. Silent dropping is rejected — a card that vanishes
without a trace is how a deck goes subtly wrong.

### Partner commanders

This affects **`.moxfield` only**. In `.mtgo` the commander stanza is explicit — Timey-Wimey's is
two lines, the other two decks' are one — so the count is read, not inferred.

`.moxfield` folds the commanders into stanza 1, unmarked: Timey-Wimey leads with `Rose Tyler` then
`The Tenth Doctor`, and stanza 1 totals 100 cards *including* them. Card count cannot
disambiguate — one commander plus 99 and two commanders plus 98 both total 100.

XMage answers this authoritatively. `mage.util.validation.CommanderValidator` — **in the `mage`
jar the bridge already depends on** — has five implementations covering every pairing mechanic:
`PartnerValidator`, `PartnerVariantValidator`, `PartnerWithValidator`, `ChooseABackgroundValidator`,
`DoctorsCompanionValidator`. `AbstractCommander.java:86` uses them exactly as we need to.

So: resolve the first two lines, materialize both via `CardInfo.createCard()`, and ask

```java
validators.stream().anyMatch(v -> v.checkBothPartners(card1, card2))
```

True → two commanders, 98 in the deck. False → one commander, line 2 rejoins the 99. Rose Tyler
holds `DoctorsCompanionAbility` and the Tenth Doctor is a Time Lord Doctor, so
`DoctorsCompanionValidator.checkPartner` returns true and the pair is detected without a line of
mechanic-specific logic of our own. New pairing mechanics arrive with the pinned jar, not with a
patch to us.

The detected commander name(s) are echoed in `lobby.state`, so a wrong call is visible before
anyone hits start.

**`CardResolver`** — the sole `CardRepository` consumer.

Names are normalized first, reproducing `TxtDeckImporter.java:118-123` so our results match what
XMage's own importer would produce:

1. `CardNameUtil.normalizeCardName` (XMage's own — accent and punctuation folding)
2. `//` → ` // ` when unspaced
3. single-slash split-card names → ` // ` via
   `replaceFirst("(?<=[^/])\\s*/\\s*(?=[^/])", " // ")`

Step 3 is not hypothetical: the Timey-Wimey deck contains `Coward / Killer` and
`Gallifrey Falls / No More`, which fail lookup without it. Both samples also contain em-dashes
(`Human—Time Lord Meta-Crisis`), which step 1 handles.

For a line with **no** set/number (`.mtgo`): `findPreferredCoreExpansionCard(name)`. Miss → hard
per-line error.

For a line **with** set/number (`.moxfield`, `.dck`), a three-step fallback:

1. name + set + collector number → exact printing. Clean hit, no diagnostic.
2. name + set → right set, any number. Emits a **warning**.
3. `findPreferredCoreExpansionCard(name)` → right card, any printing. Emits a **warning**.
4. miss → hard per-line error.

Steps 2 and 3 produce a playable deck with correct card faces and a visible list of where the
printing differs from the source. This matters because Moxfield emits **Scryfall** set codes and
XMage maintains its own; the provided samples already contain three that cannot resolve strictly
— `(PLST) C15-60`, `(PLST) EMA-26`, `(PVOW) 17p`. Treating those as fatal would reject a
perfectly legal deck over cosmetics. Warning text names the substitution:
`"Aura of Silence — no PLST printing, used C15"`.

**`DeckAssembler`** — resolves `MAYBE_COMMANDER` via the partner validators above, applies the
existing validation (main + commander = 100; 1–2 commanders), and collects `problems` (fatal) and
`warnings` (non-fatal) separately.

## 5. Protocol changes

Per `CLAUDE.md` conventions, `docs/protocol/v1.md` §5 changes first, then code.

```ts
{ t:'lobby.deck'; id; format:'auto'|'dck'|'moxfield'|'mtgo'; content: string }
```

`'list'` is removed — it was never implemented, and `'mtgo'` is what it was going to become.
`'auto'` is what the client sends; the explicit values exist for tests and for a future override.

`LobbyState.DeckInfo` gains two fields:

```ts
deck?: { valid: boolean; commander?: string[]; cards: number;
         format?: 'dck'|'moxfield'|'mtgo';   // what auto-detect concluded
         problems?: string[]; warnings?: string[] }
```

`format` is echoed so a misdetect is visible in the lobby before anyone hits start. `warnings`
renders distinctly from `problems`: a deck with warnings is `valid` and startable.

Corresponding Java: `LobbyDeck.FORMAT_LIST` is replaced by `FORMAT_AUTO`, `FORMAT_MOXFIELD`,
`FORMAT_MTGO`; `LobbyState.DeckInfo` gains `format` and `warnings`.

## 6. Client changes

Minimal by design — the client sends text and renders a verdict.

- `commands.ts:52` — `lobbyDeck` format type widens; `actions.ts:132` sends `'auto'`.
- `Lobby.tsx` — the deck panel renders the detected format and any warnings. Warnings are styled
  as advisory, not errors; the ready control stays enabled.
- The heading at `Lobby.tsx:80` ("Your deck (.dck — commander on SB: lines)") becomes format-
  agnostic: paste a `.dck`, Moxfield, or MTGO list.
- `images/deck.ts` `parseDeckIdentities` — the C5 Scryfall warm-up currently understands only
  `.dck` lines. It must handle all three shapes or it silently warms nothing for the new formats.
  This is cosmetic (warm-up is explicitly optional per `actions.ts:134`) but it is the difference
  between a snappy first turn and a cold one.

## 7. Deployment

- **Heap:** `deploy/night-bridge.service:24` — `-Xmx512m` → `-Xmx1536m`, covering H2's 150 MB
  cache with room to spare.
- **Working directory:** `DatabaseUtils.java:29` hardcodes the relative path `./db/cards.h2`. The
  bridge unit's `WorkingDirectory` is `/var/lib/commander-night`, so deploy adds a symlink
  `db → /opt/commander-night/xmage-dist/xmage/mage-server/db`. Documented in `deploy/README.md`.
  Locally the bridge already runs with repo-root cwd, so the same symlink is added there
  (gitignored) pointing at `vendor/xmage-dist/xmage/mage-server/db`.
- **New jars** from `mage-server/lib`, at dist-identical versions per the shadowing constraint in
  `CLAUDE.md`: `h2-1.4.197`, `ormlite-core-5.7`, `ormlite-jdbc-5.7`. Added to
  `install-xmage-jars.sh` and `bridge/pom.xml`.

### The drop-table guard

`CardRepository`'s constructor (`CardRepository.java:57-78`) calls `isNewBuildRun`, which compares
the `Build-Time` in the manifest of the jar holding `CardRepository.class` against a value stored
in the database. On mismatch it runs **`TableUtils.dropTable(CardInfo.class, true)`** — wiping the
145 MB card table that only the server's set scanner can rebuild.

It should never fire: the bridge loads the same `mage-1.4.60.jar`, so the manifest timestamp
matches. But a bridge deploy that silently destroys the game server's card database is an
unacceptable failure mode for a Friday night.

Mitigation: before any `CardRepository` access, bridge startup opens a **plain JDBC read-only
connection** and runs `SELECT count(*) FROM card`. If the table is missing, or the count is
implausibly low (< 20 000), the bridge **refuses to start** with a clear message pointing at the
server's DB rather than letting `CardRepository` "repair" anything. Fail-fast on a config problem
beats a wiped database discovered mid-game.

## 8. Testing

Follows the existing tiers (`docs/bridge/design.md` §13).

**Unit (no DB)** — the line parsers and the sniffer carry the bulk of the risk and none of the
infrastructure:
- sniffer: each of the three formats classified correctly, including a `.moxfield` file whose
  first card is *not* alphabetically first (guards the commander rule), and a mixed/garbage input
  that errors rather than guessing.
- `MtgoLines`: commander = last stanza (1 line, and 2 for a partner pair); a `HEADER:` stanza
  *between* main and commander discarded; trailing blank lines ignored; repeated
  names (`4 Forest` twice) preserved as separate lines rather than merged.
- `MoxfieldLines`: `*F*` stripped; `SIDEBOARD:` and `PLANES:` sections marked `DISCARD`; an
  unknown `MAYBEBOARD:` header discarded too, proving the rule is generic; collector numbers that
  are not integers (`C15-60`, `17p`) survive parsing intact.
- `DeckAssembler`: the 100-card and 1–2-commander rules, warnings vs. problems.
- name normalization: `Coward / Killer` → `Coward // Killer`.

**Live tier (`-Plive`, real DB)** — `CardResolver` and partner detection, the two parts that need
the card database:
- all three fallback steps fire, each producing the expected warning text
- every sample deck resolves to exactly 100 cards
- **partner detection**: Timey-Wimey yields two commanders; the single-commander decks yield one.
  This is the assertion that guards the riskiest inference in the design.
- a deliberately misspelled name produces a hard error, not a silent substitution

**Fixtures** — checked in under `bridge/src/test/resources/decks/`:

| Deck | Formats | Stanzas (`.mtgo`) | Pins |
|---|---|---|---|
| `enduring_enchantments` | `.mtgo`, `.moxfield` | 99 / 1 | simplest shape; PLST + PVOW fallbacks |
| `counter_intelligence` (EOC) | `.mtgo`, `.moxfield` | 99 / `SIDEBOARD:` 25 / 1 | mid-file section discard |
| `timey_wimey` (WHO) | `.mtgo`, `.moxfield` | 98 / `PLANES:` 10 / 2 | partner pair; split-card names |

Having each deck in **both** formats is the highest-value property in the suite, and Timey-Wimey
makes it sharper than mere redundancy: its `.mtgo` form states two commanders *structurally*,
while its `.moxfield` form requires the partner validators to *infer* them. Asserting the two
forms agree therefore checks the riskiest inference in the design against independent ground
truth — not just against itself.

More generally, each deck travels two entirely different code paths — one deriving set and number
from nothing, one parsing them from the file — and both must land on the same 100 card names.
That single assertion catches a bad preferred-printing pick, a broken fallback chain, and an
off-by-one in commander extraction at once.

The six sample files currently sit at the repo root, along with `upgrades_unleashed.dck`; all
seven move into the fixtures directory.

**Conformance corpus** — `docs/protocol/samples/` gains a `lobby.state` sample carrying the new
`format` and `warnings` fields, keeping `ProtocolSamplesTest` complete.

**Acceptance** — a real Moxfield export, pasted in the browser, plays a full game.

## 9. Out of scope

- **Fetching decks from a Moxfield URL.** Verified unavailable 2026-07-20: `api.moxfield.com/v2`
  and `api2.moxfield.com/v3` both return **403** to an unapproved client, before deck lookup —
  Moxfield gates its API behind Cloudflare and an approved `User-Agent`, granted on request.
  Scraping their HTML instead is fragile and against their terms, so it is not an option.
  Paste-only. Moxfield's export button copies the list in one click, so the cost is two keystrokes.
  Revisit only if an approved User-Agent is obtained.
- Format override in the client UI. Auto-detect echoes its verdict, which makes a misdetect
  visible; an override lands only if detection proves unreliable in practice.
- Planechase. `PLANES:` sections are discarded, not played — the game type is
  `Commander Free For All`.
- Other importer formats XMage ships (`.dec`, `.cod`, `.o8d`, `.mtga`).

## 10. Incidental docs fix

`CLAUDE.md` justifies the dev server's `-Xmx2048m` with "1024m OOM'd in AI simulations on a
turn-28 4-player board (2026-07-18)". That OOM was on the decommissioned 2 GiB host and is not a
sizing signal for the current 8 GiB one. The parenthetical is corrected while touching deployment
docs.
