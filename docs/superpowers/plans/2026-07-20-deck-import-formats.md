# Multi-format Deck Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept Moxfield `.moxfield` and MTGO `.mtgo` deck lists alongside XMage's native `.dck`, auto-detecting which is which, deriving set and collector number from XMage's own card database.

**Architecture:** A `night.bridge.lobby.deck` package replaces the single `DeckParser` class. Text is split into `DeckLine` records by one of three pure, database-free line parsers chosen by a sniffer; a single `CardResolver` turns those into XMage `DeckCardInfo`s via the live `CardRepository`; `DeckAssembler` applies commander and legality rules. The client is unchanged except for sending `format:'auto'` and rendering two new fields.

**Tech Stack:** Java 25 (records, sealed types), JUnit 5, XMage 1.4.60 jars (`mage`, `mage-common`), H2 1.4.197 + ORMLite 5.7 (from the dist), React + Zustand client, Maven.

## Global Constraints

- **XMage version is pinned at 1.4.60.** All new jars come from `vendor/xmage-dist/xmage/mage-client/lib` at dist-identical versions. Never pull them from Central.
- **Never bypass `XmageAnswers`** — not touched by this work, but do not add `session.sendPlayer*` calls.
- **Wire-protocol changes go into `docs/protocol/v1.md` first, then code.** Task 9 enforces this ordering.
- **Modern Java (release 25):** records and sealed interfaces for protocol types.
- **One owning executor per piece of mutable state.** Deck parsing runs on the lobby executor, as `LobbyService.deck()` already does. Do not introduce threads.
- **Logging:** our code uses slf4j/logback. Never add an `slf4j-reload4j` binding.
- Test tiers: unit tests run under `mvn test`. Anything needing the card database is `@Tag("live")` and runs only under `mvn -Plive test`.
- Reference spec: `docs/superpowers/specs/2026-07-20-deck-import-formats-design.md`.

---

### Task 1: Card database access and the drop-table guard

The bridge gains read access to XMage's card database. `CardRepository`'s constructor drops the card table if it thinks the jar is newer than the database (`CardRepository.java:66-72`), so nothing may touch `CardRepository` until a guard has confirmed the table is intact.

**Files:**
- Modify: `bridge/install-xmage-jars.sh`
- Modify: `bridge/pom.xml`
- Create: `bridge/src/main/java/night/bridge/lobby/deck/CardDb.java`
- Create: `bridge/src/test/java/night/bridge/lobby/deck/CardDbLiveTest.java`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `CardDb.require()` → void (throws `IllegalStateException`); `CardDb.cards()` → `mage.cards.repository.CardRepository`.

- [ ] **Step 1: Add the three jars to the install script**

In `bridge/install-xmage-jars.sh`, after the `jspf-core` line, add:

```sh
# Card database stack (CardRepository — deck import resolves names through it)
install h2-1.4.197.jar                com.h2database     h2                1.4.197
install ormlite-core-5.7.jar          com.j256.ormlite   ormlite-core      5.7
install ormlite-jdbc-5.7.jar          com.j256.ormlite   ormlite-jdbc      5.7
```

- [ ] **Step 2: Run the install script**

Run: `./bridge/install-xmage-jars.sh`
Expected: ends with `done — bridge/pom.xml can now resolve the XMage stack`, and the three new `installed ...` lines appear.

- [ ] **Step 3: Add the dependencies to pom.xml**

In `bridge/pom.xml`, inside `<dependencies>`, after the `jspf-core` dependency:

```xml
    <dependency>
      <groupId>com.h2database</groupId>
      <artifactId>h2</artifactId>
      <version>1.4.197</version>
    </dependency>
    <dependency>
      <groupId>com.j256.ormlite</groupId>
      <artifactId>ormlite-core</artifactId>
      <version>5.7</version>
    </dependency>
    <dependency>
      <groupId>com.j256.ormlite</groupId>
      <artifactId>ormlite-jdbc</artifactId>
      <version>5.7</version>
    </dependency>
```

- [ ] **Step 4: Create the local `db` symlink and ignore it**

`DatabaseUtils.prepareH2Connection` hardcodes the relative path `./db/cards.h2`, and the bridge runs with repo-root as cwd.

Run:
```sh
cd /home/ricardop/Projects/commander-night
ln -sfn vendor/xmage-dist/xmage/mage-server/db db
```

Append to `.gitignore`:
```
# symlink to the XMage dist's card database (see docs/.../deck-import-formats)
/db
```

- [ ] **Step 5: Write the failing guard test**

Create `bridge/src/test/java/night/bridge/lobby/deck/CardDbLiveTest.java`:

```java
package night.bridge.lobby.deck;

import mage.cards.repository.CardInfo;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

@Tag("live")
class CardDbLiveTest {

    @Test
    void guardPassesAgainstTheDistDatabase() {
        CardDb.require();
    }

    @Test
    void resolvesAKnownPrinting() {
        CardDb.require();
        CardInfo sol = CardDb.cards().findCard("CMM", "410");
        assertNotNull(sol, "CMM:410 should be Sol Ring");
        assertEquals("Sol Ring", sol.getName());
    }
}
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd bridge && mvn -Plive test -Dtest=CardDbLiveTest`
Expected: compilation failure — `cannot find symbol: class CardDb`.

- [ ] **Step 7: Implement CardDb**

Create `bridge/src/main/java/night/bridge/lobby/deck/CardDb.java`:

```java
package night.bridge.lobby.deck;

import mage.cards.repository.CardRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * Access to XMage's own card database (design: deck import spec §3).
 *
 * <p><b>Why the guard.</b> {@code CardRepository}'s constructor compares the
 * {@code Build-Time} of the jar holding {@code CardRepository.class} against a
 * value stored in the database and, on a mismatch, runs
 * {@code TableUtils.dropTable(CardInfo.class, true)} — wiping a table only the
 * game server's set scanner can rebuild. It should never fire (we load the same
 * pinned {@code mage-1.4.60.jar}), but a bridge start that destroys the game
 * server's card database is not a failure we are willing to risk. So a plain
 * JDBC read confirms the table is intact <em>before</em> any CardRepository
 * touch, and startup aborts rather than letting it "repair" anything.
 */
public final class CardDb {

    private static final Logger log = LoggerFactory.getLogger(CardDb.class);

    /** XMage 1.4.60 ships ~100k rows; anything near-empty means a wiped or half-built db. */
    private static final int MIN_PLAUSIBLE_CARDS = 20_000;

    private static final String URL = "jdbc:h2:file:./db/cards.h2;AUTO_SERVER=TRUE;IGNORECASE=TRUE";

    private static volatile boolean checked;

    /**
     * Verifies the card database is present and populated. Idempotent; throws
     * {@link IllegalStateException} with a operator-actionable message otherwise.
     */
    public static synchronized void require() {
        if (checked) {
            return;
        }
        int count;
        try (Connection c = DriverManager.getConnection(URL, "", "");
             Statement s = c.createStatement();
             ResultSet rs = s.executeQuery("SELECT count(*) FROM card")) {
            rs.next();
            count = rs.getInt(1);
        } catch (SQLException e) {
            throw new IllegalStateException(
                    "cannot read XMage's card database at ./db/cards.h2 — deck import needs it. "
                            + "Expected a symlink 'db' pointing at the dist's mage-server/db directory. "
                            + "Cause: " + e.getMessage(), e);
        }
        if (count < MIN_PLAUSIBLE_CARDS) {
            throw new IllegalStateException(
                    "XMage's card database holds only " + count + " cards (expected >= "
                            + MIN_PLAUSIBLE_CARDS + "). Refusing to start rather than let "
                            + "CardRepository rebuild it. Start the XMage server once to repopulate.");
        }
        log.info("card database ok: {} cards", count);
        checked = true;
    }

    /** The repository. {@link #require()} must have passed first. */
    public static CardRepository cards() {
        require();
        return CardRepository.instance;
    }

    private CardDb() {
    }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Start the XMage server is *not* required (H2 `AUTO_SERVER` works either way).

Run: `cd bridge && mvn -Plive test -Dtest=CardDbLiveTest`
Expected: PASS, 2 tests, with `card database ok: NNNNN cards` in the output where NNNNN > 20000.

- [ ] **Step 9: Commit**

```bash
git add bridge/install-xmage-jars.sh bridge/pom.xml .gitignore \
        bridge/src/main/java/night/bridge/lobby/deck/CardDb.java \
        bridge/src/test/java/night/bridge/lobby/deck/CardDbLiveTest.java
git commit -m "Deck import: card database access with a drop-table guard"
```

---

### Task 2: Move the sample decks into test fixtures

Six sample files and the existing `.dck` sit at the repo root. Tests need them on the classpath.

**Files:**
- Move: `*.mtgo`, `*.moxfield`, `upgrades_unleashed.dck` → `bridge/src/test/resources/decks/`
- Create: `bridge/src/test/java/night/bridge/lobby/deck/Fixtures.java`

**Interfaces:**
- Produces: `Fixtures.read(String name)` → `String` (e.g. `Fixtures.read("timey_wimey.mtgo")`).

- [ ] **Step 1: Move the files**

```bash
cd /home/ricardop/Projects/commander-night
mkdir -p bridge/src/test/resources/decks
git mv enduring_enchantments.mtgo enduring_enchantments.moxfield \
       counter_intelligence.mtgo counter_intelligence.moxfield \
       timey_wimey.mtgo timey_wimey.moxfield \
       upgrades_unleashed.dck \
       bridge/src/test/resources/decks/
```

- [ ] **Step 2: Verify the move**

Run: `ls bridge/src/test/resources/decks/`
Expected: exactly seven files, and `ls *.mtgo *.moxfield *.dck` at the repo root reports no matches.

- [ ] **Step 3: Add the fixture reader**

Create `bridge/src/test/java/night/bridge/lobby/deck/Fixtures.java`:

```java
package night.bridge.lobby.deck;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;

/**
 * Sample decks under src/test/resources/decks (deck-import spec §8). Public so the
 * live tier in {@code night.bridge.live} can paste them too.
 */
public final class Fixtures {

    public static String read(String name) {
        try (InputStream in = Fixtures.class.getResourceAsStream("/decks/" + name)) {
            if (in == null) {
                throw new IllegalArgumentException("no such deck fixture: " + name);
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private Fixtures() {
    }
}
```

- [ ] **Step 4: Commit**

```bash
git add -A bridge/src/test/resources/decks bridge/src/test/java/night/bridge/lobby/deck/Fixtures.java
git commit -m "Deck import: sample decks as test fixtures"
```

---

### Task 3: DeckLine, ParsedLines, and the stanza splitter

The shared vocabulary. Pure string work — no database.

**Files:**
- Create: `bridge/src/main/java/night/bridge/lobby/deck/DeckLine.java`
- Create: `bridge/src/main/java/night/bridge/lobby/deck/ParsedLines.java`
- Create: `bridge/src/main/java/night/bridge/lobby/deck/Stanzas.java`
- Create: `bridge/src/test/java/night/bridge/lobby/deck/StanzasTest.java`

**Interfaces:**
- Produces:
  - `DeckLine(int qty, String name, String setCode, String number, DeckLine.Section section, int lineNo)`, `Section` = `MAIN | COMMANDER | MAYBE_COMMANDER`
  - `ParsedLines(List<DeckLine> lines, List<String> problems, List<ParsedLines.Discarded> discarded)`, `Discarded(String section, int cards)`
  - `Stanzas.split(String text)` → `List<Stanzas.Stanza>`; `Stanza(String header, List<Stanzas.Raw> lines)` with nullable `header`; `Raw(int lineNo, String text)`

- [ ] **Step 1: Write the failing stanza test**

Create `bridge/src/test/java/night/bridge/lobby/deck/StanzasTest.java`:

```java
package night.bridge.lobby.deck;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class StanzasTest {

    @Test
    void splitsOnBlankLinesAndKeepsLineNumbers() {
        List<Stanzas.Stanza> s = Stanzas.split("1 A\n1 B\n\n1 C\n");
        assertEquals(2, s.size());
        assertNull(s.get(0).header());
        assertEquals(2, s.get(0).lines().size());
        assertEquals(1, s.get(0).lines().get(0).lineNo());
        assertEquals("1 C", s.get(1).lines().get(0).text());
        assertEquals(4, s.get(1).lines().get(0).lineNo());
    }

    @Test
    void recognisesAHeaderStanza() {
        List<Stanzas.Stanza> s = Stanzas.split("1 A\n\nPLANES:\n1 Pompeii\n");
        assertEquals(2, s.size());
        assertEquals("PLANES:", s.get(1).header());
        assertEquals(1, s.get(1).lines().size());
        assertEquals("1 Pompeii", s.get(1).lines().get(0).text());
    }

    @Test
    void ignoresRepeatedAndTrailingBlankLines() {
        // trailing blanks are how every sample file ends
        assertEquals(1, Stanzas.split("1 A\n\n\n").size());
        assertEquals(0, Stanzas.split("\n\n").size());
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd bridge && mvn test -Dtest=StanzasTest`
Expected: compilation failure — `cannot find symbol: class Stanzas`.

- [ ] **Step 3: Implement the three types**

Create `bridge/src/main/java/night/bridge/lobby/deck/DeckLine.java`:

```java
package night.bridge.lobby.deck;

/**
 * One card line, format-independent (deck-import spec §4). {@code setCode} and
 * {@code number} are null when the source format does not carry them (.mtgo).
 */
public record DeckLine(int qty, String name, String setCode, String number,
                       Section section, int lineNo) {

    public enum Section {
        MAIN,
        COMMANDER,
        /** .moxfield line 2: a commander only if it partners with line 1 (needs the card db). */
        MAYBE_COMMANDER
    }

    public DeckLine withSection(Section s) {
        return new DeckLine(qty, name, setCode, number, s, lineNo);
    }
}
```

Create `bridge/src/main/java/night/bridge/lobby/deck/ParsedLines.java`:

```java
package night.bridge.lobby.deck;

import java.util.List;

/**
 * A line parser's output. Discarded sections are summarised rather than carried:
 * nothing downstream wants their cards, but the player must be told they were
 * dropped (deck-import spec §4).
 */
public record ParsedLines(List<DeckLine> lines, List<String> problems, List<Discarded> discarded) {

    public record Discarded(String section, int cards) {
    }
}
```

Create `bridge/src/main/java/night/bridge/lobby/deck/Stanzas.java`:

```java
package night.bridge.lobby.deck;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Blank-line-delimited stanzas, the grammar both Moxfield-produced formats share
 * (deck-import spec §4). A stanza whose first line is a bare {@code HEADER:} is a
 * named extra section — {@code SIDEBOARD:}, {@code PLANES:} — and its header is
 * split out from its cards.
 */
final class Stanzas {

    private static final Pattern HEADER = Pattern.compile("^[A-Za-z][A-Za-z ]*:$");

    record Raw(int lineNo, String text) {
    }

    /** {@code header} is null for an unnamed stanza. */
    record Stanza(String header, List<Raw> lines) {
    }

    static List<Stanza> split(String text) {
        List<Stanza> out = new ArrayList<>();
        List<Raw> current = new ArrayList<>();
        int lineNo = 0;
        for (String raw : text.split("\\r?\\n", -1)) {
            lineNo++;
            String line = raw.strip();
            if (line.isEmpty()) {
                flush(out, current);
                current = new ArrayList<>();
                continue;
            }
            current.add(new Raw(lineNo, line));
        }
        flush(out, current);
        return out;
    }

    private static void flush(List<Stanza> out, List<Raw> lines) {
        if (lines.isEmpty()) {
            return;
        }
        String first = lines.get(0).text();
        if (HEADER.matcher(first).matches()) {
            out.add(new Stanza(first, List.copyOf(lines.subList(1, lines.size()))));
        } else {
            out.add(new Stanza(null, List.copyOf(lines)));
        }
    }

    private Stanzas() {
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd bridge && mvn test -Dtest=StanzasTest`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/main/java/night/bridge/lobby/deck/ bridge/src/test/java/night/bridge/lobby/deck/StanzasTest.java
git commit -m "Deck import: DeckLine, ParsedLines and the stanza splitter"
```

---

### Task 4: The format sniffer

**Files:**
- Create: `bridge/src/main/java/night/bridge/lobby/deck/DeckFormat.java`
- Create: `bridge/src/test/java/night/bridge/lobby/deck/DeckFormatTest.java`

**Interfaces:**
- Consumes: `Fixtures.read` (Task 2).
- Produces: `enum DeckFormat { DCK, MOXFIELD, MTGO }` with `DeckFormat.sniff(String text)` → `DeckFormat` (throws `IllegalArgumentException` when nothing is card-shaped) and `wire()` → `String` (`"dck"`, `"moxfield"`, `"mtgo"`).

- [ ] **Step 1: Write the failing test**

Create `bridge/src/test/java/night/bridge/lobby/deck/DeckFormatTest.java`:

```java
package night.bridge.lobby.deck;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class DeckFormatTest {

    @Test
    void detectsEachFixture() {
        assertEquals(DeckFormat.DCK, DeckFormat.sniff(Fixtures.read("upgrades_unleashed.dck")));
        assertEquals(DeckFormat.MTGO, DeckFormat.sniff(Fixtures.read("timey_wimey.mtgo")));
        assertEquals(DeckFormat.MOXFIELD, DeckFormat.sniff(Fixtures.read("timey_wimey.moxfield")));
        assertEquals(DeckFormat.MTGO, DeckFormat.sniff(Fixtures.read("counter_intelligence.mtgo")));
        assertEquals(DeckFormat.MOXFIELD, DeckFormat.sniff(Fixtures.read("counter_intelligence.moxfield")));
    }

    /** A .dck line also matches the loose .mtgo shape, so precedence must be dck-first. */
    @Test
    void dckBeatsMtgoOnAmbiguousLines() {
        assertEquals(DeckFormat.DCK, DeckFormat.sniff("1 [MKC:145] Agitator Ant\n"));
    }

    /** One malformed line must not flip the verdict — the vote is over all card lines. */
    @Test
    void majorityWinsOverASingleOddLine() {
        assertEquals(DeckFormat.MOXFIELD,
                DeckFormat.sniff("1 Sol Ring (CMM) 410\n1 Command Tower (CMM) 420\n1 Mystery\n"));
    }

    @Test
    void rejectsTextWithNoCardLines() {
        assertThrows(IllegalArgumentException.class, () -> DeckFormat.sniff("hello\nworld\n"));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd bridge && mvn test -Dtest=DeckFormatTest`
Expected: compilation failure — `cannot find symbol: class DeckFormat`.

- [ ] **Step 3: Implement the sniffer**

Create `bridge/src/main/java/night/bridge/lobby/deck/DeckFormat.java`:

```java
package night.bridge.lobby.deck;

import java.util.EnumMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Which of the three syntaxes a pasted deck is (deck-import spec §4). The shapes
 * are mutually exclusive per line: .dck puts [SET:NUM] <em>before</em> the name,
 * .moxfield puts (SET) NUM <em>after</em> it, .mtgo has neither.
 *
 * <p>Classification is a majority vote over card-shaped lines rather than
 * first-match, so one malformed line cannot flip the verdict. Precedence is
 * dck → moxfield → mtgo, because the .mtgo shape ("qty then anything") also
 * matches lines of the other two.
 */
public enum DeckFormat {

    DCK("dck"),
    MOXFIELD("moxfield"),
    MTGO("mtgo");

    static final Pattern DCK_LINE = Pattern.compile("^(?:SB:\\s*)?\\d+\\s+\\[[^:\\]]+:[^\\]]+]");
    static final Pattern MOX_LINE = Pattern.compile("\\([^)]+\\)\\s+\\S+(?:\\s+\\*\\w+\\*)*$");
    static final Pattern MTGO_LINE = Pattern.compile("^\\d+\\s+\\S");

    private final String wire;

    DeckFormat(String wire) {
        this.wire = wire;
    }

    public String wire() {
        return wire;
    }

    public static DeckFormat sniff(String text) {
        Map<DeckFormat, Integer> votes = new EnumMap<>(DeckFormat.class);
        for (String raw : text.split("\\r?\\n")) {
            String line = raw.strip();
            if (line.isEmpty()) {
                continue;
            }
            if (line.startsWith("LAYOUT") || DCK_LINE.matcher(line).find()) {
                votes.merge(DCK, 1, Integer::sum);
            } else if (MOX_LINE.matcher(line).find()) {
                votes.merge(MOXFIELD, 1, Integer::sum);
            } else if (MTGO_LINE.matcher(line).find()) {
                votes.merge(MTGO, 1, Integer::sum);
            }
        }
        return votes.entrySet().stream()
                .max(Map.Entry.comparingByValue())
                .map(Map.Entry::getKey)
                .orElseThrow(() -> new IllegalArgumentException(
                        "cannot tell what deck format this is — expected .dck "
                                + "(1 [SET:NUM] Name), Moxfield (1 Name (SET) NUM) "
                                + "or MTGO (1 Name) lines"));
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd bridge && mvn test -Dtest=DeckFormatTest`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/main/java/night/bridge/lobby/deck/DeckFormat.java \
        bridge/src/test/java/night/bridge/lobby/deck/DeckFormatTest.java
git commit -m "Deck import: format sniffer"
```

---

### Task 5: MtgoLines — the stanza-structured plain list

`.mtgo` is `main / [HEADER: section]* / commander`. The commander is the **last unnamed stanza**, which is why two of the three fixtures have two blank lines.

**Files:**
- Create: `bridge/src/main/java/night/bridge/lobby/deck/MtgoLines.java`
- Create: `bridge/src/test/java/night/bridge/lobby/deck/MtgoLinesTest.java`

**Interfaces:**
- Consumes: `Stanzas`, `DeckLine`, `ParsedLines` (Task 3); `Fixtures` (Task 2).
- Produces: `MtgoLines.parse(String text)` → `ParsedLines`.

- [ ] **Step 1: Write the failing test**

Create `bridge/src/test/java/night/bridge/lobby/deck/MtgoLinesTest.java`:

```java
package night.bridge.lobby.deck;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MtgoLinesTest {

    private static List<DeckLine> commanders(ParsedLines p) {
        return p.lines().stream().filter(l -> l.section() == DeckLine.Section.COMMANDER).toList();
    }

    private static int cards(ParsedLines p) {
        return p.lines().stream().mapToInt(DeckLine::qty).sum();
    }

    @Test
    void singleCommanderInTheLastStanza() {
        ParsedLines p = MtgoLines.parse(Fixtures.read("enduring_enchantments.mtgo"));
        assertTrue(p.problems().isEmpty(), () -> String.valueOf(p.problems()));
        assertEquals(100, cards(p));
        assertEquals(List.of("Anikthea, Hand of Erebos"),
                commanders(p).stream().map(DeckLine::name).toList());
        assertNull(p.lines().get(0).setCode(), ".mtgo carries no set code");
    }

    /** The partner pair is structural here: the commander stanza simply has two lines. */
    @Test
    void partnerPairAndDiscardedPlanesSection() {
        ParsedLines p = MtgoLines.parse(Fixtures.read("timey_wimey.mtgo"));
        assertTrue(p.problems().isEmpty(), () -> String.valueOf(p.problems()));
        assertEquals(100, cards(p));
        assertEquals(List.of("Rose Tyler", "The Tenth Doctor"),
                commanders(p).stream().map(DeckLine::name).toList());
        assertEquals(List.of(new ParsedLines.Discarded("PLANES:", 10)), p.discarded());
    }

    /** The section sits between main and commander, not at the end. */
    @Test
    void discardsAMidFileSideboardSection() {
        ParsedLines p = MtgoLines.parse(Fixtures.read("counter_intelligence.mtgo"));
        assertTrue(p.problems().isEmpty(), () -> String.valueOf(p.problems()));
        assertEquals(100, cards(p));
        assertEquals(List.of("Inspirit, Flagship Vessel"),
                commanders(p).stream().map(DeckLine::name).toList());
        assertEquals(List.of(new ParsedLines.Discarded("SIDEBOARD:", 25)), p.discarded());
    }

    @Test
    void repeatedNamesAreKeptAsSeparateLines() {
        // Moxfield emits "4 Forest" twice for two printings; merging would lose a line
        ParsedLines p = MtgoLines.parse("4 Forest\n4 Forest\n\n1 Sythis, Harvest's Hand\n");
        assertEquals(2, p.lines().stream().filter(l -> l.name().equals("Forest")).count());
        assertEquals(9, cards(p));
    }

    @Test
    void reportsAMissingCommanderStanza() {
        ParsedLines p = MtgoLines.parse("1 Sol Ring\n1 Command Tower\n");
        assertEquals(1, p.problems().size());
        assertTrue(p.problems().get(0).contains("commander"), p.problems().get(0));
    }

    @Test
    void reportsAnUnparseableLine() {
        ParsedLines p = MtgoLines.parse("1 Sol Ring\nnot a card line\n\n1 Anikthea, Hand of Erebos\n");
        assertEquals(1, p.problems().size());
        assertTrue(p.problems().get(0).contains("line 2"), p.problems().get(0));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd bridge && mvn test -Dtest=MtgoLinesTest`
Expected: compilation failure — `cannot find symbol: class MtgoLines`.

- [ ] **Step 3: Implement MtgoLines**

Create `bridge/src/main/java/night/bridge/lobby/deck/MtgoLines.java`:

```java
package night.bridge.lobby.deck;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * MTGO plain list (deck-import spec §4): {@code N Name} lines, blank-line
 * stanzas, commander in the <b>last unnamed stanza</b>.
 *
 * <p>Note this is deliberately <em>not</em> XMage's {@code TxtDeckImporter} rule,
 * which sends everything after the <em>first</em> blank line to the sideboard and
 * errors on a second one. Real Moxfield MTGO exports interleave a {@code PLANES:}
 * or {@code SIDEBOARD:} section between the deck and the commander, so two of our
 * three fixtures have two blank lines and XMage's own importer mis-handles them.
 */
final class MtgoLines {

    private static final Pattern LINE = Pattern.compile("^(\\d+)\\s+(.+?)\\s*$");

    static ParsedLines parse(String text) {
        List<Stanzas.Stanza> stanzas = Stanzas.split(text);
        List<DeckLine> lines = new ArrayList<>();
        List<String> problems = new ArrayList<>();
        List<ParsedLines.Discarded> discarded = new ArrayList<>();

        List<Stanzas.Stanza> body = new ArrayList<>();
        for (Stanzas.Stanza s : stanzas) {
            if (s.header() != null) {
                discarded.add(new ParsedLines.Discarded(s.header(), countCards(s, problems)));
            } else {
                body.add(s);
            }
        }

        if (body.isEmpty()) {
            problems.add("no cards found");
            return new ParsedLines(List.of(), List.copyOf(problems), List.copyOf(discarded));
        }
        if (body.size() == 1) {
            problems.add("no commander: an MTGO list puts the commander in its own stanza, "
                    + "after a blank line");
        }

        int last = body.size() - 1;
        for (int i = 0; i < body.size(); i++) {
            DeckLine.Section section = (body.size() > 1 && i == last)
                    ? DeckLine.Section.COMMANDER
                    : DeckLine.Section.MAIN;
            if (body.size() > 2 && i > 0 && i < last) {
                problems.add("unexpected extra section at line " + body.get(i).lines().get(0).lineNo()
                        + " — an MTGO list should be deck, then optional named sections, "
                        + "then the commander");
            }
            for (Stanzas.Raw raw : body.get(i).lines()) {
                Matcher m = LINE.matcher(raw.text());
                if (!m.matches()) {
                    problems.add("line " + raw.lineNo() + ": cannot parse: " + abbreviate(raw.text()));
                    continue;
                }
                lines.add(new DeckLine(Integer.parseInt(m.group(1)), m.group(2).strip(),
                        null, null, section, raw.lineNo()));
            }
        }
        return new ParsedLines(List.copyOf(lines), List.copyOf(problems), List.copyOf(discarded));
    }

    private static int countCards(Stanzas.Stanza s, List<String> problems) {
        int n = 0;
        for (Stanzas.Raw raw : s.lines()) {
            Matcher m = LINE.matcher(raw.text());
            if (m.matches()) {
                n += Integer.parseInt(m.group(1));
            } else {
                problems.add("line " + raw.lineNo() + ": cannot parse: " + abbreviate(raw.text()));
            }
        }
        return n;
    }

    static String abbreviate(String line) {
        return line.length() <= 60 ? line : line.substring(0, 57) + "...";
    }

    private MtgoLines() {
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd bridge && mvn test -Dtest=MtgoLinesTest`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/main/java/night/bridge/lobby/deck/MtgoLines.java \
        bridge/src/test/java/night/bridge/lobby/deck/MtgoLinesTest.java
git commit -m "Deck import: MTGO line parser"
```

---

### Task 6: MoxfieldLines — commanders folded into stanza 1

`.moxfield` puts commanders at the *head* of stanza 1, unmarked. Line 2 becomes `MAYBE_COMMANDER`; only the card database can say whether it partners with line 1, and that happens in Task 9.

**Files:**
- Create: `bridge/src/main/java/night/bridge/lobby/deck/MoxfieldLines.java`
- Create: `bridge/src/test/java/night/bridge/lobby/deck/MoxfieldLinesTest.java`

**Interfaces:**
- Consumes: `Stanzas`, `DeckLine`, `ParsedLines` (Task 3); `MtgoLines.abbreviate` (Task 5); `Fixtures` (Task 2).
- Produces: `MoxfieldLines.parse(String text)` → `ParsedLines`.

- [ ] **Step 1: Write the failing test**

Create `bridge/src/test/java/night/bridge/lobby/deck/MoxfieldLinesTest.java`:

```java
package night.bridge.lobby.deck;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MoxfieldLinesTest {

    private static int cards(ParsedLines p) {
        return p.lines().stream().mapToInt(DeckLine::qty).sum();
    }

    @Test
    void parsesSetAndCollectorNumber() {
        ParsedLines p = MoxfieldLines.parse(Fixtures.read("enduring_enchantments.moxfield"));
        assertTrue(p.problems().isEmpty(), () -> String.valueOf(p.problems()));
        assertEquals(100, cards(p));
        DeckLine first = p.lines().get(0);
        assertEquals("Anikthea, Hand of Erebos", first.name(), "the *F* foil marker is stripped");
        assertEquals("CMM", first.setCode());
        assertEquals("705", first.number());
        assertEquals(DeckLine.Section.COMMANDER, first.section());
        assertEquals(DeckLine.Section.MAYBE_COMMANDER, p.lines().get(1).section());
        assertEquals(DeckLine.Section.MAIN, p.lines().get(2).section());
    }

    /** PLST/PVOW numbers are not integers; they must survive parsing intact. */
    @Test
    void keepsNonNumericCollectorNumbers() {
        ParsedLines p = MoxfieldLines.parse("1 Sythis, Harvest's Hand (CMM) 938\n"
                + "1 Aura of Silence (PLST) C15-60\n1 Hallowed Haunting (PVOW) 17p\n");
        assertEquals("C15-60", p.lines().get(1).number());
        assertEquals("17p", p.lines().get(2).number());
    }

    @Test
    void discardsNamedSections() {
        ParsedLines p = MoxfieldLines.parse(Fixtures.read("counter_intelligence.moxfield"));
        assertTrue(p.problems().isEmpty(), () -> String.valueOf(p.problems()));
        assertEquals(100, cards(p));
        assertEquals(List.of(new ParsedLines.Discarded("SIDEBOARD:", 25)), p.discarded());
    }

    /** The rule is generic, not a SIDEBOARD:/PLANES: allow-list. */
    @Test
    void discardsAnUnknownSection() {
        ParsedLines p = MoxfieldLines.parse(
                "1 Sol Ring (CMM) 410\n1 Command Tower (CMM) 420\n\nMAYBEBOARD:\n2 Farseek (CMM) 894\n");
        assertEquals(List.of(new ParsedLines.Discarded("MAYBEBOARD:", 2)), p.discarded());
        assertEquals(2, cards(p));
    }

    @Test
    void reportsAnUnparseableLine() {
        ParsedLines p = MoxfieldLines.parse("1 Sol Ring (CMM) 410\nnope\n");
        assertEquals(1, p.problems().size());
        assertTrue(p.problems().get(0).contains("line 2"), p.problems().get(0));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd bridge && mvn test -Dtest=MoxfieldLinesTest`
Expected: compilation failure — `cannot find symbol: class MoxfieldLines`.

- [ ] **Step 3: Implement MoxfieldLines**

Create `bridge/src/main/java/night/bridge/lobby/deck/MoxfieldLines.java`:

```java
package night.bridge.lobby.deck;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Moxfield native export (deck-import spec §4): {@code N Name (SET) NUM *F*}.
 *
 * <p>Commanders are folded into the head of stanza 1, unmarked — a partner pair
 * occupies lines 1 and 2, a lone commander only line 1, and nothing in the text
 * distinguishes the two cases (the {@code *F*} foil marker appears on ordinary
 * cards too). Line 2 is therefore {@link DeckLine.Section#MAYBE_COMMANDER} and
 * {@code DeckAssembler} settles it against the card database.
 *
 * <p>Collector numbers are <b>not</b> parsed as integers: {@code (PLST) C15-60}
 * and {@code (PVOW) 17p} are real values from the sample decks.
 */
final class MoxfieldLines {

    private static final Pattern LINE = Pattern.compile(
            "^(\\d+)\\s+(.+?)\\s+\\(([^)]+)\\)\\s+(\\S+?)((?:\\s+\\*\\w+\\*)*)\\s*$");

    static ParsedLines parse(String text) {
        List<Stanzas.Stanza> stanzas = Stanzas.split(text);
        List<DeckLine> lines = new ArrayList<>();
        List<String> problems = new ArrayList<>();
        List<ParsedLines.Discarded> discarded = new ArrayList<>();

        List<Stanzas.Stanza> body = new ArrayList<>();
        for (Stanzas.Stanza s : stanzas) {
            if (s.header() != null) {
                discarded.add(new ParsedLines.Discarded(s.header(), countCards(s, problems)));
            } else {
                body.add(s);
            }
        }

        if (body.isEmpty()) {
            problems.add("no cards found");
            return new ParsedLines(List.of(), List.copyOf(problems), List.copyOf(discarded));
        }
        for (int i = 1; i < body.size(); i++) {
            problems.add("unexpected blank line at line " + body.get(i).lines().get(0).lineNo()
                    + " — a Moxfield list is one block, optionally followed by named sections");
        }

        for (Stanzas.Raw raw : body.get(0).lines()) {
            Matcher m = LINE.matcher(raw.text());
            if (!m.matches()) {
                problems.add("line " + raw.lineNo() + ": cannot parse: "
                        + MtgoLines.abbreviate(raw.text()));
                continue;
            }
            DeckLine.Section section = switch (lines.size()) {
                case 0 -> DeckLine.Section.COMMANDER;
                case 1 -> DeckLine.Section.MAYBE_COMMANDER;
                default -> DeckLine.Section.MAIN;
            };
            lines.add(new DeckLine(Integer.parseInt(m.group(1)), m.group(2).strip(),
                    m.group(3).strip(), m.group(4).strip(), section, raw.lineNo()));
        }
        return new ParsedLines(List.copyOf(lines), List.copyOf(problems), List.copyOf(discarded));
    }

    private static int countCards(Stanzas.Stanza s, List<String> problems) {
        int n = 0;
        for (Stanzas.Raw raw : s.lines()) {
            Matcher m = LINE.matcher(raw.text());
            if (m.matches()) {
                n += Integer.parseInt(m.group(1));
            } else {
                problems.add("line " + raw.lineNo() + ": cannot parse: "
                        + MtgoLines.abbreviate(raw.text()));
            }
        }
        return n;
    }

    private MoxfieldLines() {
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd bridge && mvn test -Dtest=MoxfieldLinesTest`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/main/java/night/bridge/lobby/deck/MoxfieldLines.java \
        bridge/src/test/java/night/bridge/lobby/deck/MoxfieldLinesTest.java
git commit -m "Deck import: Moxfield line parser"
```

---

### Task 7: DckLines — port the existing parser

Behaviour must not change: `DeckParserTest` already pins it. This task moves the logic behind the new `ParsedLines` interface without altering what it accepts.

**Files:**
- Create: `bridge/src/main/java/night/bridge/lobby/deck/DckLines.java`
- Create: `bridge/src/test/java/night/bridge/lobby/deck/DckLinesTest.java`

**Interfaces:**
- Consumes: `DeckLine`, `ParsedLines` (Task 3); `MtgoLines.abbreviate` (Task 5).
- Produces: `DckLines.parse(String text)` → `ParsedLines`.

- [ ] **Step 1: Write the failing test**

Create `bridge/src/test/java/night/bridge/lobby/deck/DckLinesTest.java`:

```java
package night.bridge.lobby.deck;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DckLinesTest {

    @Test
    void parsesTheDistSampleDeck() {
        ParsedLines p = DckLines.parse(Fixtures.read("upgrades_unleashed.dck"));
        assertTrue(p.problems().isEmpty(), () -> String.valueOf(p.problems()));
        assertEquals(100, p.lines().stream().mapToInt(DeckLine::qty).sum());
        assertEquals(List.of("Chishiro, the Shattered Blade"),
                p.lines().stream()
                        .filter(l -> l.section() == DeckLine.Section.COMMANDER)
                        .map(DeckLine::name).toList());
    }

    @Test
    void headerAndLayoutLinesAreIgnored() {
        ParsedLines p = DckLines.parse("NAME: x\nAUTHOR: y\nLAYOUT MAIN:(1,1)|([C21:100])\n"
                + "1 [C21:263] Command Tower\nSB: 1 [KHM:222] Lathril, Blade of the Elves\n");
        assertTrue(p.problems().isEmpty(), () -> String.valueOf(p.problems()));
        assertEquals(2, p.lines().size());
    }

    @Test
    void quantityExpandsAndFieldsLandInTheRightSlots() {
        ParsedLines p = DckLines.parse("9 [HOB:198] Swamp\n");
        DeckLine only = p.lines().get(0);
        assertEquals(9, only.qty());
        assertEquals("Swamp", only.name());
        assertEquals("HOB", only.setCode());
        assertEquals("198", only.number());
    }

    @Test
    void reportsAnUnparseableLine() {
        ParsedLines p = DckLines.parse("1 [C21:263] Command Tower\ngarbage\n");
        assertEquals(1, p.problems().size());
        assertTrue(p.problems().get(0).contains("line 2"), p.problems().get(0));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd bridge && mvn test -Dtest=DckLinesTest`
Expected: compilation failure — `cannot find symbol: class DckLines`.

- [ ] **Step 3: Implement DckLines**

Create `bridge/src/main/java/night/bridge/lobby/deck/DckLines.java`:

```java
package night.bridge.lobby.deck;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * XMage's native .dck (deck-import spec §4): {@code N [SET:NUM] Name} lines,
 * {@code SB:} marking the sideboard — where Commander decks keep the commander.
 * {@code LAYOUT}/{@code NAME:}/{@code AUTHOR:} metadata lines are skipped; the
 * LAYOUT lines repeat every identity in the deck, so they must not be parsed.
 */
final class DckLines {

    private static final Pattern LINE =
            Pattern.compile("^(SB:\\s*)?(\\d+)\\s+\\[([^:\\]]+):([^\\]]+)]\\s+(.+?)\\s*$");
    private static final Pattern HEADER = Pattern.compile("^(NAME:|AUTHOR:|LAYOUT).*");

    static ParsedLines parse(String text) {
        List<DeckLine> lines = new ArrayList<>();
        List<String> problems = new ArrayList<>();
        int lineNo = 0;
        for (String raw : text.split("\\r?\\n")) {
            lineNo++;
            String line = raw.strip();
            if (line.isEmpty() || HEADER.matcher(line).matches()) {
                continue;
            }
            Matcher m = LINE.matcher(line);
            if (!m.matches()) {
                problems.add("line " + lineNo + ": cannot parse: " + MtgoLines.abbreviate(line));
                continue;
            }
            lines.add(new DeckLine(
                    Integer.parseInt(m.group(2)), m.group(5).strip(), m.group(3), m.group(4),
                    m.group(1) != null ? DeckLine.Section.COMMANDER : DeckLine.Section.MAIN,
                    lineNo));
        }
        return new ParsedLines(List.copyOf(lines), List.copyOf(problems), List.of());
    }

    private DckLines() {
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd bridge && mvn test -Dtest=DckLinesTest`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/main/java/night/bridge/lobby/deck/DckLines.java \
        bridge/src/test/java/night/bridge/lobby/deck/DckLinesTest.java
git commit -m "Deck import: .dck line parser"
```

---

### Task 8: CardResolver — names to printings, with the soft fallback

The only class that touches the card database.

**Files:**
- Create: `bridge/src/main/java/night/bridge/lobby/deck/CardResolver.java`
- Create: `bridge/src/test/java/night/bridge/lobby/deck/CardResolverLiveTest.java`

**Interfaces:**
- Consumes: `CardDb` (Task 1), `DeckLine` (Task 3).
- Produces: `CardResolver.resolve(DeckLine line)` → `CardResolver.Resolved`; `Resolved(DeckLine line, mage.cards.repository.CardInfo card, String warning, String problem)` where exactly one of `card`/`problem` is non-null and `warning` is nullable. Also `CardResolver.normalize(String name)` → `String`.

- [ ] **Step 1: Write the failing test**

Create `bridge/src/test/java/night/bridge/lobby/deck/CardResolverLiveTest.java`:

```java
package night.bridge.lobby.deck;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

@Tag("live")
class CardResolverLiveTest {

    private static DeckLine line(String name, String set, String num) {
        return new DeckLine(1, name, set, num, DeckLine.Section.MAIN, 1);
    }

    /** Step 1: exact set + number, no diagnostic. */
    @Test
    void exactPrintingResolvesCleanly() {
        CardResolver.Resolved r = CardResolver.resolve(line("Sol Ring", "CMM", "410"));
        assertNotNull(r.card());
        assertEquals("Sol Ring", r.card().getName());
        assertEquals("CMM", r.card().getSetCode());
        assertEquals("410", r.card().getCardNumber());
        assertNull(r.warning());
    }

    /** Step 2: right set, wrong number — warn and use another printing from that set. */
    @Test
    void wrongNumberFallsBackWithinTheSet() {
        CardResolver.Resolved r = CardResolver.resolve(line("Sol Ring", "CMM", "99999"));
        assertNotNull(r.card());
        assertEquals("CMM", r.card().getSetCode());
        assertNotNull(r.warning());
        assertTrue(r.warning().contains("Sol Ring"), r.warning());
    }

    /** Step 3: Moxfield emits Scryfall set codes XMage does not have. */
    @Test
    void unknownSetFallsBackToPreferredPrinting() {
        CardResolver.Resolved r = CardResolver.resolve(line("Aura of Silence", "PLST", "C15-60"));
        assertNotNull(r.card());
        assertEquals("Aura of Silence", r.card().getName());
        assertNotNull(r.warning());
        assertTrue(r.warning().contains("PLST"), r.warning());
    }

    /** .mtgo lines carry no set or number at all. */
    @Test
    void bareNameUsesThePreferredPrinting() {
        CardResolver.Resolved r = CardResolver.resolve(line("Anointed Procession", null, null));
        assertNotNull(r.card());
        assertEquals("Anointed Procession", r.card().getName());
        assertNull(r.warning());
    }

    /** Single-slash split names must be normalised or lookup misses. */
    @Test
    void normalisesSplitCardNames() {
        assertEquals("Coward // Killer", CardResolver.normalize("Coward / Killer"));
        assertEquals("Gallifrey Falls // No More", CardResolver.normalize("Gallifrey Falls / No More"));
        CardResolver.Resolved r = CardResolver.resolve(line("Coward / Killer", null, null));
        assertNotNull(r.card(), () -> String.valueOf(r.problem()));
    }

    @Test
    void aMisspellingIsAHardError() {
        CardResolver.Resolved r = CardResolver.resolve(line("Sol Rong", null, null));
        assertNull(r.card());
        assertNotNull(r.problem());
        assertTrue(r.problem().contains("Sol Rong"), r.problem());
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd bridge && mvn -Plive test -Dtest=CardResolverLiveTest`
Expected: compilation failure — `cannot find symbol: class CardResolver`.

- [ ] **Step 3: Implement CardResolver**

Create `bridge/src/main/java/night/bridge/lobby/deck/CardResolver.java`:

```java
package night.bridge.lobby.deck;

import mage.cards.decks.CardNameUtil;
import mage.cards.repository.CardInfo;

import java.util.List;

/**
 * Card name (plus optional printing) → a real XMage printing (deck-import spec §4).
 * The sole consumer of the card database.
 *
 * <p><b>Soft fallback.</b> Moxfield emits Scryfall set codes and XMage maintains
 * its own, so a strict lookup rejects legal decks over cosmetics — the sample
 * decks alone contain {@code (PLST) C15-60}, {@code (PLST) EMA-26} and
 * {@code (PVOW) 17p}. A missed set or number therefore downgrades to a warning
 * and a different printing of the same card; only a missed <em>name</em> is fatal.
 */
public final class CardResolver {

    /** Exactly one of {@code card} and {@code problem} is non-null. */
    public record Resolved(DeckLine line, CardInfo card, String warning, String problem) {
    }

    /**
     * Reproduces {@code TxtDeckImporter}'s normalisation so our lookups match what
     * XMage's own importer would find.
     */
    public static String normalize(String rawName) {
        String name = CardNameUtil.normalizeCardName(rawName);
        if (name.contains("//") && !name.contains(" // ")) {
            name = name.replace("//", " // ");
        }
        return name.replaceFirst("(?<=[^/])\\s*/\\s*(?=[^/])", " // ");
    }

    public static Resolved resolve(DeckLine line) {
        String name = normalize(line.name());

        if (line.setCode() == null) {
            CardInfo preferred = CardDb.cards().findPreferredCoreExpansionCard(name);
            return preferred == null ? miss(line, name) : new Resolved(line, preferred, null, null);
        }

        List<CardInfo> printings = CardDb.cards().findCards(name);

        // 1 — exact set + number
        CardInfo exact = printings.stream()
                .filter(c -> c.getSetCode().equalsIgnoreCase(line.setCode()))
                .filter(c -> c.getCardNumber().equalsIgnoreCase(line.number()))
                .findFirst().orElse(null);
        if (exact != null) {
            return new Resolved(line, exact, null, null);
        }

        // 2 — right set, any number
        CardInfo inSet = printings.stream()
                .filter(c -> c.getSetCode().equalsIgnoreCase(line.setCode()))
                .findFirst().orElse(null);
        if (inSet != null) {
            return new Resolved(line, inSet,
                    line.name() + " — no " + line.setCode() + ":" + line.number()
                            + " printing, used " + inSet.getSetCode() + ":" + inSet.getCardNumber(),
                    null);
        }

        // 3 — right card, any printing
        CardInfo preferred = CardDb.cards().findPreferredCoreExpansionCard(name);
        if (preferred != null) {
            return new Resolved(line, preferred,
                    line.name() + " — no " + line.setCode() + " printing, used "
                            + preferred.getSetCode() + ":" + preferred.getCardNumber(),
                    null);
        }
        return miss(line, name);
    }

    private static Resolved miss(DeckLine line, String normalized) {
        return new Resolved(line, null, null,
                "line " + line.lineNo() + ": no such card: " + line.name()
                        + (normalized.equals(line.name()) ? "" : " (read as '" + normalized + "')"));
    }

    private CardResolver() {
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd bridge && mvn -Plive test -Dtest=CardResolverLiveTest`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/main/java/night/bridge/lobby/deck/CardResolver.java \
        bridge/src/test/java/night/bridge/lobby/deck/CardResolverLiveTest.java
git commit -m "Deck import: card resolver with soft printing fallback"
```

---

### Task 9: DeckAssembler — partner detection and legality

Settles `MAYBE_COMMANDER` using XMage's own commander validators, then builds the `DeckCardLists` and the diagnostics.

**Files:**
- Create: `bridge/src/main/java/night/bridge/lobby/deck/DeckAssembler.java`
- Create: `bridge/src/main/java/night/bridge/lobby/deck/DeckImport.java`
- Create: `bridge/src/test/java/night/bridge/lobby/deck/DeckAssemblerLiveTest.java`

**Interfaces:**
- Consumes: `CardResolver` (Task 8), `ParsedLines`/`DeckLine` (Task 3).
- Produces:
  - `DeckImport(DeckFormat format, mage.cards.decks.DeckCardLists deck, List<String> commander, int cards, List<String> problems, List<String> warnings)` with `boolean valid()` → `problems.isEmpty()`
  - `DeckAssembler.assemble(DeckFormat format, ParsedLines lines)` → `DeckImport`

- [ ] **Step 1: Write the failing test**

Create `bridge/src/test/java/night/bridge/lobby/deck/DeckAssemblerLiveTest.java`:

```java
package night.bridge.lobby.deck;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

@Tag("live")
class DeckAssemblerLiveTest {

    private static DeckImport importOf(String fixture) {
        String text = Fixtures.read(fixture);
        DeckFormat format = DeckFormat.sniff(text);
        ParsedLines lines = switch (format) {
            case DCK -> DckLines.parse(text);
            case MTGO -> MtgoLines.parse(text);
            case MOXFIELD -> MoxfieldLines.parse(text);
        };
        return DeckAssembler.assemble(format, lines);
    }

    /** Moxfield hides the partner pair; only the validators can find it. */
    @Test
    void detectsAPartnerPairInMoxfield() {
        DeckImport d = importOf("timey_wimey.moxfield");
        assertTrue(d.valid(), () -> String.valueOf(d.problems()));
        assertEquals(List.of("Rose Tyler", "The Tenth Doctor"), d.commander());
        assertEquals(2, d.deck().getSideboard().size());
        assertEquals(98, d.deck().getCards().size());
    }

    /** A commander followed by an ordinary card must NOT become a pair. */
    @Test
    void doesNotInventAPartnerPair() {
        DeckImport d = importOf("enduring_enchantments.moxfield");
        assertTrue(d.valid(), () -> String.valueOf(d.problems()));
        assertEquals(List.of("Anikthea, Hand of Erebos"), d.commander());
        assertEquals(99, d.deck().getCards().size());
    }

    @Test
    void discardedSectionBecomesAWarningNotAProblem() {
        DeckImport d = importOf("counter_intelligence.moxfield");
        assertTrue(d.valid(), () -> String.valueOf(d.problems()));
        assertEquals(1, d.warnings().stream().filter(w -> w.contains("SIDEBOARD:")).count(),
                () -> String.valueOf(d.warnings()));
        assertTrue(d.warnings().stream().anyMatch(w -> w.contains("25")),
                () -> String.valueOf(d.warnings()));
    }

    /**
     * The suite's sharpest assertion: .mtgo states the commander count
     * structurally, .moxfield must infer it. Agreement checks the inference
     * against independent ground truth (deck-import spec §8).
     */
    @Test
    void bothFormatsOfTheSameDeckAgree() {
        for (String deck : List.of("enduring_enchantments", "counter_intelligence", "timey_wimey")) {
            DeckImport mtgo = importOf(deck + ".mtgo");
            DeckImport mox = importOf(deck + ".moxfield");
            assertTrue(mtgo.valid(), () -> deck + ".mtgo: " + mtgo.problems());
            assertTrue(mox.valid(), () -> deck + ".moxfield: " + mox.problems());
            assertEquals(100, mtgo.cards(), deck + ".mtgo card count");
            assertEquals(100, mox.cards(), deck + ".moxfield card count");
            assertEquals(mtgo.commander(), mox.commander(), deck + ": commanders disagree");
            assertEquals(names(mtgo), names(mox), deck + ": deck contents disagree");
        }
    }

    private static List<String> names(DeckImport d) {
        return d.deck().getCards().stream().map(c -> c.getCardName()).sorted().toList();
    }

    @Test
    void rejectsAShortDeck() {
        DeckImport d = DeckAssembler.assemble(DeckFormat.MTGO,
                MtgoLines.parse("1 Sol Ring\n\n1 Anikthea, Hand of Erebos\n"));
        assertFalse(d.valid());
        assertTrue(d.problems().stream().anyMatch(p -> p.contains("100")),
                () -> String.valueOf(d.problems()));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd bridge && mvn -Plive test -Dtest=DeckAssemblerLiveTest`
Expected: compilation failure — `cannot find symbol: class DeckAssembler`.

- [ ] **Step 3: Implement DeckImport**

Create `bridge/src/main/java/night/bridge/lobby/deck/DeckImport.java`:

```java
package night.bridge.lobby.deck;

import mage.cards.decks.DeckCardLists;

import java.util.List;

/**
 * The result of importing a pasted deck (deck-import spec §5). {@code warnings}
 * are non-fatal: a deck carrying them is still {@link #valid()} and startable.
 */
public record DeckImport(DeckFormat format, DeckCardLists deck, List<String> commander,
                         int cards, List<String> problems, List<String> warnings) {

    public boolean valid() {
        return problems.isEmpty();
    }
}
```

- [ ] **Step 4: Implement DeckAssembler**

Create `bridge/src/main/java/night/bridge/lobby/deck/DeckAssembler.java`:

```java
package night.bridge.lobby.deck;

import mage.cards.Card;
import mage.cards.decks.DeckCardInfo;
import mage.cards.decks.DeckCardLists;
import mage.cards.repository.CardInfo;
import mage.util.validation.ChooseABackgroundValidator;
import mage.util.validation.CommanderValidator;
import mage.util.validation.DoctorsCompanionValidator;
import mage.util.validation.PartnerValidator;
import mage.util.validation.PartnerVariantValidator;
import mage.util.validation.PartnerWithValidator;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Resolved lines → an XMage {@link DeckCardLists} plus diagnostics
 * (deck-import spec §4).
 *
 * <p><b>Partners.</b> Only .moxfield needs inference: it folds commanders into the
 * head of its single stanza, and card count cannot disambiguate (one commander
 * plus 99 and two plus 98 both total 100). XMage answers this itself — the five
 * {@link CommanderValidator}s cover every pairing mechanic (Partner, Partner with,
 * partner variants, Backgrounds, Doctor's companion), so new mechanics arrive with
 * the pinned jar rather than a patch to us.
 */
public final class DeckAssembler {

    private static final List<CommanderValidator> VALIDATORS = List.of(
            PartnerValidator.instance,
            PartnerVariantValidator.instance,
            PartnerWithValidator.instance,
            ChooseABackgroundValidator.instance,
            DoctorsCompanionValidator.instance);

    public static DeckImport assemble(DeckFormat format, ParsedLines parsed) {
        List<String> problems = new ArrayList<>(parsed.problems());
        List<String> warnings = new ArrayList<>();
        for (ParsedLines.Discarded d : parsed.discarded()) {
            warnings.add("ignored " + d.cards() + " cards in section " + d.section());
        }

        List<CardResolver.Resolved> resolved = new ArrayList<>();
        for (DeckLine line : parsed.lines()) {
            CardResolver.Resolved r = CardResolver.resolve(line);
            if (r.problem() != null) {
                problems.add(r.problem());
                continue;
            }
            if (r.warning() != null) {
                warnings.add(r.warning());
            }
            resolved.add(r);
        }

        boolean partners = isPartnerPair(resolved);
        DeckCardLists deck = new DeckCardLists();
        Set<String> commanders = new LinkedHashSet<>();
        for (CardResolver.Resolved r : resolved) {
            boolean commander = switch (r.line().section()) {
                case COMMANDER -> true;
                case MAYBE_COMMANDER -> partners;
                case MAIN -> false;
            };
            CardInfo card = r.card();
            for (int i = 0; i < r.line().qty(); i++) {
                DeckCardInfo info = new DeckCardInfo(
                        card.getName(), card.getCardNumber(), card.getSetCode());
                (commander ? deck.getSideboard() : deck.getCards()).add(info);
            }
            if (commander) {
                commanders.add(card.getName());
            }
        }

        int main = deck.getCards().size();
        int side = deck.getSideboard().size();
        if (main + side != 100) {
            problems.add("Commander decks are exactly 100 cards; this one has "
                    + main + " deck + " + side + " commander = " + (main + side));
        }
        if (side < 1 || side > 2) {
            problems.add("expected 1–2 commanders, found " + side);
        }

        return new DeckImport(format, deck, List.copyOf(commanders), main + side,
                List.copyOf(problems), List.copyOf(warnings));
    }

    /**
     * True when the first two resolved lines are a legal commander pair. Only
     * consulted for {@link DeckLine.Section#MAYBE_COMMANDER}; .dck and .mtgo state
     * their commander count structurally.
     */
    private static boolean isPartnerPair(List<CardResolver.Resolved> resolved) {
        CardInfo first = sectionCard(resolved, DeckLine.Section.COMMANDER);
        CardInfo second = sectionCard(resolved, DeckLine.Section.MAYBE_COMMANDER);
        if (first == null || second == null) {
            return false;
        }
        Card a = first.createCard();
        Card b = second.createCard();
        return VALIDATORS.stream().anyMatch(v -> v.checkBothPartners(a, b));
    }

    private static CardInfo sectionCard(List<CardResolver.Resolved> resolved, DeckLine.Section s) {
        return resolved.stream()
                .filter(r -> r.line().section() == s)
                .map(CardResolver.Resolved::card)
                .findFirst().orElse(null);
    }

    private DeckAssembler() {
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd bridge && mvn -Plive test -Dtest=DeckAssemblerLiveTest`
Expected: PASS, 5 tests. If `bothFormatsOfTheSameDeckAgree` fails on a printing mismatch, that is the fallback chain or preferred-printing choice being wrong — fix `CardResolver`, not the assertion.

- [ ] **Step 6: Commit**

```bash
git add bridge/src/main/java/night/bridge/lobby/deck/DeckImport.java \
        bridge/src/main/java/night/bridge/lobby/deck/DeckAssembler.java \
        bridge/src/test/java/night/bridge/lobby/deck/DeckAssemblerLiveTest.java
git commit -m "Deck import: assembler with XMage-native partner detection"
```

---

### Task 10: DeckImporter facade

One entry point, so `LobbyService` never learns which parser exists.

**Files:**
- Create: `bridge/src/main/java/night/bridge/lobby/deck/DeckImporter.java`
- Create: `bridge/src/test/java/night/bridge/lobby/deck/DeckImporterLiveTest.java`

**Interfaces:**
- Consumes: everything from Tasks 3–9.
- Produces: `DeckImporter.imp0rt(String requestedFormat, String text)` → `DeckImport`, where `requestedFormat` is `"auto"`, `"dck"`, `"moxfield"`, or `"mtgo"`.

- [ ] **Step 1: Write the failing test**

Create `bridge/src/test/java/night/bridge/lobby/deck/DeckImporterLiveTest.java`:

```java
package night.bridge.lobby.deck;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

@Tag("live")
class DeckImporterLiveTest {

    @Test
    void autoDetectsAndEchoesTheFormat() {
        DeckImport d = DeckImporter.imp0rt("auto", Fixtures.read("timey_wimey.mtgo"));
        assertTrue(d.valid(), () -> String.valueOf(d.problems()));
        assertEquals(DeckFormat.MTGO, d.format());
    }

    @Test
    void honoursAnExplicitFormat() {
        DeckImport d = DeckImporter.imp0rt("moxfield", Fixtures.read("timey_wimey.moxfield"));
        assertEquals(DeckFormat.MOXFIELD, d.format());
        assertTrue(d.valid(), () -> String.valueOf(d.problems()));
    }

    @Test
    void unrecognisableTextIsAProblemNotAnException() {
        DeckImport d = DeckImporter.imp0rt("auto", "hello\nworld\n");
        assertFalse(d.valid());
        assertEquals(1, d.problems().size());
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd bridge && mvn -Plive test -Dtest=DeckImporterLiveTest`
Expected: compilation failure — `cannot find symbol: class DeckImporter`.

- [ ] **Step 3: Implement DeckImporter**

Create `bridge/src/main/java/night/bridge/lobby/deck/DeckImporter.java`:

```java
package night.bridge.lobby.deck;

import mage.cards.decks.DeckCardLists;

import java.util.List;
import java.util.Locale;

/**
 * The deck-import entry point (deck-import spec §4). Callers hand over text and a
 * requested format; everything downstream is internal to this package.
 */
public final class DeckImporter {

    /**
     * @param requestedFormat {@code "auto"}, {@code "dck"}, {@code "moxfield"} or {@code "mtgo"}
     * @return never null — an unusable deck comes back with {@code problems}, not an exception
     */
    public static DeckImport imp0rt(String requestedFormat, String text) {
        DeckFormat format;
        try {
            format = "auto".equalsIgnoreCase(requestedFormat)
                    ? DeckFormat.sniff(text)
                    : DeckFormat.valueOf(requestedFormat.toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return failed(e.getMessage());
        }
        ParsedLines lines = switch (format) {
            case DCK -> DckLines.parse(text);
            case MTGO -> MtgoLines.parse(text);
            case MOXFIELD -> MoxfieldLines.parse(text);
        };
        return DeckAssembler.assemble(format, lines);
    }

    private static DeckImport failed(String problem) {
        return new DeckImport(null, new DeckCardLists(), List.of(), 0, List.of(problem), List.of());
    }

    private DeckImporter() {
    }
}
```

> Note on the name: `import` is a Java keyword, so the method is `imp0rt`. Do not rename it in
> later tasks — `LobbyService` calls it by this name.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd bridge && mvn -Plive test -Dtest=DeckImporterLiveTest`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/main/java/night/bridge/lobby/deck/DeckImporter.java \
        bridge/src/test/java/night/bridge/lobby/deck/DeckImporterLiveTest.java
git commit -m "Deck import: DeckImporter facade"
```

---

### Task 11: Protocol — document first, then the wire types

`CLAUDE.md`: *wire-protocol changes happen in `docs/protocol/v1.md` first, then code follows.* Do the doc edit in step 1 and do not reorder.

**Files:**
- Modify: `docs/protocol/v1.md:110`, `docs/protocol/v1.md:118-124`, `docs/protocol/v1.md:126-128`
- Modify: `bridge/src/main/java/night/bridge/proto/LobbyDeck.java`
- Modify: `bridge/src/main/java/night/bridge/proto/LobbyState.java:17-22`
- Create: `docs/protocol/samples/lobby.state.deck-warnings.json`
- Modify: `client/src/protocol/protocol.ts:44`, `client/src/protocol/protocol.ts:53`

**Interfaces:**
- Consumes: `DeckFormat` (Task 4).
- Produces: `LobbyDeck.FORMAT_AUTO/FORMAT_DCK/FORMAT_MOXFIELD/FORMAT_MTGO`; `LobbyState.DeckInfo(boolean valid, List<String> commander, int cards, String format, List<String> problems, List<String> warnings)`.

- [ ] **Step 1: Update the protocol document**

In `docs/protocol/v1.md`, replace the `lobby.deck` command line:

```ts
{ t:'lobby.deck';   id; format:'auto'|'dck'|'moxfield'|'mtgo'; content: string }
```

Replace the `seats` line in `LobbyState` with:

```ts
  seats: { userId: Id; name: string;
           deck?: { valid: boolean; commander?: string[]; cards: number;
                    format?: 'dck'|'moxfield'|'mtgo';
                    problems?: string[]; warnings?: string[] };
           ready: boolean }[];
```

Replace the paragraph beginning "`lobby.deck` acks with the parse result" with:

```markdown
`lobby.deck` acks with the parse result (commander names, card count) or errors with per-line
diagnostics. Three syntaxes are accepted: XMage's `.dck` (`N [SET:NUM] Name`, `SB:` = commander),
Moxfield's native export (`N Name (SET) NUM`, commanders leading), and MTGO plain lists
(`N Name`, commander in a trailing blank-line-delimited stanza). Clients send `format:'auto'`;
the bridge sniffs the syntax and echoes what it concluded in `deck.format`, so a misdetection is
visible before anyone starts. MTGO lists carry no printing information, so the bridge derives set
and collector number from the pinned XMage server's card database.

`problems` are fatal — the deck is not `valid` and the seat cannot ready. `warnings` are advisory
and a deck carrying them is startable: they report discarded sections (Moxfield's `SIDEBOARD:` and
`PLANES:` have no place in an XMage Commander deck) and printing substitutions (Moxfield emits
Scryfall set codes, which XMage does not always share; the card is correct, the art may differ).
```

- [ ] **Step 2: Commit the protocol change on its own**

```bash
git add docs/protocol/v1.md
git commit -m "Protocol v1 §5: three deck formats, auto-detection, deck warnings"
```

- [ ] **Step 3: Update LobbyDeck**

Replace the body of `bridge/src/main/java/night/bridge/proto/LobbyDeck.java`:

```java
package night.bridge.proto;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Deck submission as text (protocol §5). Clients send {@code auto} and let the
 * bridge sniff between {@code dck}, {@code moxfield} and {@code mtgo}; the
 * explicit values exist for tests and a future manual override. Acked with the
 * parse result; problems and warnings are reported via the lobby.state deck info.
 */
public record LobbyDeck(
        @JsonProperty(required = true) String id,
        @JsonProperty(required = true) String format,
        @JsonProperty(required = true) String content) implements ClientMsg {

    public static final String FORMAT_AUTO = "auto";
    public static final String FORMAT_DCK = "dck";
    public static final String FORMAT_MOXFIELD = "moxfield";
    public static final String FORMAT_MTGO = "mtgo";
}
```

- [ ] **Step 4: Update LobbyState.DeckInfo**

In `bridge/src/main/java/night/bridge/proto/LobbyState.java`, replace the `DeckInfo` record:

```java
    public record DeckInfo(
            boolean valid,
            List<String> commander,
            int cards,
            String format,
            List<String> problems,
            List<String> warnings) {
    }
```

- [ ] **Step 5: Mirror the types in the client**

In `client/src/protocol/protocol.ts`, replace line 44:

```ts
export interface LobbyDeck   extends Command { t: 'lobby.deck';   format: 'auto' | 'dck' | 'moxfield' | 'mtgo'; content: string }
```

and the `seats` field of the lobby state interface (line 53):

```ts
  seats: { userId: Id; name: string; deck?: { valid: boolean; commander?: string[];
           cards: number; format?: 'dck' | 'moxfield' | 'mtgo';
           problems?: string[]; warnings?: string[] }; ready: boolean }[];
```

- [ ] **Step 6: Add the conformance sample**

Create `docs/protocol/samples/lobby.state.deck-warnings.json`:

```json
{
  "t": "lobby.state",
  "code": "K7M2QX",
  "hostUserId": "u_9f2a",
  "seats": [
    {
      "userId": "u_9f2a",
      "name": "Ricardo",
      "deck": {
        "valid": true,
        "commander": ["Rose Tyler", "The Tenth Doctor"],
        "cards": 100,
        "format": "moxfield",
        "warnings": [
          "ignored 10 cards in section PLANES:",
          "Aura of Silence — no PLST:C15-60 printing, used C15:60"
        ]
      },
      "ready": false
    }
  ]
}
```

- [ ] **Step 7: Run the conformance and codec suites**

Run: `cd bridge && mvn test -Dtest='ProtocolSamplesTest+CodecTest'`
Expected: PASS. A failure here means `DeckInfo`'s Jackson shape does not match the sample — fix the record, not the sample.

- [ ] **Step 8: Commit**

```bash
git add bridge/src/main/java/night/bridge/proto/LobbyDeck.java \
        bridge/src/main/java/night/bridge/proto/LobbyState.java \
        client/src/protocol/protocol.ts \
        docs/protocol/samples/lobby.state.deck-warnings.json
git commit -m "Deck import: wire types for auto-detection and warnings"
```

---

### Task 12: Wire the importer into LobbyService

**Files:**
- Modify: `bridge/src/main/java/night/bridge/lobby/LobbyService.java:214-243` (the `deck` method), `:356-378` (`sampleDecks`), `:407` (the `DeckInfo` construction), imports
- Delete: `bridge/src/main/java/night/bridge/lobby/DeckParser.java`
- Delete: `bridge/src/test/java/night/bridge/lobby/DeckParserTest.java`
- Modify: `bridge/src/main/java/night/bridge/Main.java` (startup guard)

**Interfaces:**
- Consumes: `DeckImporter.imp0rt` (Task 10), `DeckImport` (Task 9), `CardDb.require` (Task 1).
- Produces: `SeatEntry.deck` is now a `DeckImport` rather than a `DeckParser.Parsed`.

- [ ] **Step 1: Replace the deck command handler**

In `LobbyService.java`, replace the whole `deck` method (lines 214-243) with:

```java
    private void deck(String userId, LobbyDeck cmd, Consumer<ServerMsg> reply) {
        SeatEntry seat = seatOf(userId);
        if (seat == null) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "join a lobby seat first"));
            return;
        }
        if (cmd.content() == null || cmd.content().isBlank()) {
            reply.accept(Err.re(cmd.id(), ErrorCode.DECK_INVALID, "deck content is empty"));
            return;
        }
        Lobby lobby = byUser.get(userId);
        if (lobby.started) {
            reply.accept(Err.re(cmd.id(), ErrorCode.LOBBY_STATE, "game already started"));
            return;
        }
        lobby.lastTouch = System.currentTimeMillis();
        seat.deck = DeckImporter.imp0rt(cmd.format(), cmd.content());
        seat.ready = false; // a new deck resets readiness
        reply.accept(new Ack(cmd.id()));
        broadcast(lobby);
    }
```

Note the `FORMAT_LIST` and unknown-format rejections are gone: `DeckImporter` now reports an
unknown format as a deck problem rather than a command error, so the lobby renders it inline
like every other deck diagnostic.

- [ ] **Step 2: Update the field type, DeckInfo construction, and sample decks**

At `LobbyService.java:72`, replace `DeckParser.Parsed deck;` with:

```java
        DeckImport deck;
```

Replace the `DeckInfo` construction (around line 407) with:

```java
                    s.deck == null ? null : new LobbyState.DeckInfo(
                            s.deck.valid(),
                            s.deck.commander().isEmpty() ? null : s.deck.commander(),
                            s.deck.cards(),
                            s.deck.format() == null ? null : s.deck.format().wire(),
                            s.deck.problems().isEmpty() ? null : s.deck.problems(),
                            s.deck.warnings().isEmpty() ? null : s.deck.warnings()),
```

In `sampleDecks`, replace the parse call:

```java
                DeckImport parsed = DeckImporter.imp0rt(LobbyDeck.FORMAT_DCK, Files.readString(file));
                if (parsed.valid()) {
                    pool.add(parsed.deck());
                } else {
                    log.warn("sample deck {} skipped: {}", file.getFileName(), parsed.problems());
                }
```

Update imports: remove nothing from `mage.cards.decks.DeckCardLists`, and add

```java
import night.bridge.lobby.deck.DeckImport;
import night.bridge.lobby.deck.DeckImporter;
```

- [ ] **Step 3: Add the startup guard**

In `bridge/src/main/java/night/bridge/Main.java`, immediately after configuration is loaded and
before any listener binds, add:

```java
        // Deck import resolves card names through XMage's card database; fail fast
        // with an operator-actionable message rather than at first deck submission.
        night.bridge.lobby.deck.CardDb.require();
```

- [ ] **Step 4: Delete the old parser and its test**

```bash
git rm bridge/src/main/java/night/bridge/lobby/DeckParser.java \
       bridge/src/test/java/night/bridge/lobby/DeckParserTest.java
```

Their coverage now lives in `DckLinesTest` (parsing) and `DeckAssemblerLiveTest` (validation).

- [ ] **Step 5: Build and run the unit tier**

Run: `cd bridge && mvn test`
Expected: BUILD SUCCESS, no compilation errors. Any remaining reference to `DeckParser` is a
missed call site — fix it.

- [ ] **Step 6: Run the live tier**

Start the XMage server first:
```sh
(cd vendor/xmage-dist/xmage/mage-server && ../../java/jre1.8.0_201/bin/java -Xmx2048m -jar lib/mage-server-1.4.60.jar)
```

Run: `cd bridge && mvn -Plive test`
Expected: BUILD SUCCESS. `LiveGameTest` and `MultiHumanLiveTest` must still pass — they exercise
`sampleDecks`, which now goes through `DeckImporter`.

- [ ] **Step 7: Commit**

```bash
git add -A bridge/src
git commit -m "Deck import: wire DeckImporter into the lobby, retire DeckParser"
```

---

### Task 13: Client — send auto, render format and warnings

**Files:**
- Modify: `client/src/protocol/commands.ts:52-54`
- Modify: `client/src/net/actions.ts:130-140`
- Modify: `client/src/ui/screens/Lobby.tsx:61-72`, `:79-87`
- Modify: `client/src/images/deck.ts`
- Modify: `client/src/styles.css`

**Interfaces:**
- Consumes: the `LobbyDeck` and lobby-state types from Task 11.
- Produces: no new exports beyond `parseDeckIdentities` keeping its signature.

- [ ] **Step 1: Widen the command builder**

In `client/src/protocol/commands.ts`, replace the `lobbyDeck` function:

```ts
export function lobbyDeck(ctx: CommandContext, opts: { format: 'auto' | 'dck' | 'moxfield' | 'mtgo'; content: string }): LobbyDeck {
  return { t: 'lobby.deck', id: ctx.mintId(), format: opts.format, content: opts.content };
}
```

- [ ] **Step 2: Send `auto`**

In `client/src/net/actions.ts`, in `submitDeckFlow`, replace the send line:

```ts
    unwrap(await manager.send(lobbyDeck(ctx, { format: 'auto', content })));
```

- [ ] **Step 3: Teach the image warm-up all three formats**

Replace the body of `client/src/images/deck.ts`:

```ts
// Deck text → card identities, for the C5 image cache warm-up (design §9).
//
// Three syntaxes, matching what the bridge accepts:
//   1 [MKC:145] Agitator Ant           .dck        set + number
//   1 Agitator Ant (MKC) 145 *F*       .moxfield   set + number, foil marker stripped
//   1 Agitator Ant                     .mtgo       name only
//
// .mtgo lines carry no printing, so they warm by name alone: the resolver's
// lookup ladder already falls back to /cards/named?exact= when number is ''.
// The bridge picks the actual printing, so a name-warmed image may differ from
// the one dealt — warm-up is optional and cosmetic either way.
//
// The .dck LAYOUT lines repeat every identity in the deck, so this parses line
// by line and skips them: a whole-text regex scan would yield the deck twice.
// Identities also repeat legitimately (nine copies of [HOB:198]), so the result
// is deduped on the resolver's own set/number identity.

import type { CardIdentity } from './scryfall';

const DCK_LINE = /^(?:SB:\s*)?\d+\s+\[([^:\]]+):([^\]]*)\]\s+(.+?)$/;
const MOX_LINE = /^\d+\s+(.+?)\s+\(([^)]+)\)\s+(\S+?)(?:\s+\*\w+\*)*$/;
const MTGO_LINE = /^\d+\s+(.+?)$/;
const SECTION = /^[A-Za-z][A-Za-z ]*:$/;

export function parseDeckIdentities(text: string): CardIdentity[] {
  const out: CardIdentity[] = [];
  const seen = new Set<string>();
  const push = (set: string, number: string, name: string): void => {
    const key = number === '' ? `/${name.toLowerCase()}` : `${set.toLowerCase()}/${number}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ set, number, name: name.trim() });
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('LAYOUT') || SECTION.test(line)) continue;
    const dck = DCK_LINE.exec(line);
    if (dck !== null) {
      const [, set, number, name] = dck as unknown as [string, string, string, string];
      push(set, number, name);
      continue;
    }
    const mox = MOX_LINE.exec(line);
    if (mox !== null) {
      const [, name, set, number] = mox as unknown as [string, string, string, string];
      push(set, number, name);
      continue;
    }
    const mtgo = MTGO_LINE.exec(line);
    if (mtgo !== null) {
      const [, name] = mtgo as unknown as [string, string];
      push('', '', name);
    }
  }
  return out;
}
```

- [ ] **Step 4: Render format and warnings in the lobby**

In `client/src/ui/screens/Lobby.tsx`, replace the seat deck block (lines 61-72):

```tsx
            {seat.deck ? (
              <span className="deck-status">
                {seat.deck.valid ? (
                  <span className="deck-ok">
                    {seat.deck.cards} cards{seat.deck.commander?.length ? ` — ${seat.deck.commander.join(' + ')}` : ''}
                    {seat.deck.format !== undefined && <em className="deck-format"> ({seat.deck.format})</em>}
                  </span>
                ) : (
                  <ul className="deck-problems">
                    {(seat.deck.problems ?? ['deck invalid']).map((p, i) => <li key={i}>{p}</li>)}
                  </ul>
                )}
                {seat.userId === userId && seat.deck.warnings?.length ? (
                  <ul className="deck-warnings">
                    {seat.deck.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                ) : null}
              </span>
            ) : (
              <span className="deck-missing">no deck yet</span>
            )}
```

Warnings render only on your own seat: they name specific cards, and an opponent's list is
hidden information.

Replace the heading and placeholder (lines 80-86):

```tsx
        <h2>Your deck</h2>
        <p className="deck-hint">
          Paste a Moxfield export, an MTGO list, or an XMage .dck — the format is detected for you.
        </p>
        <textarea
          value={deckText}
          rows={10}
          spellCheck={false}
          placeholder={'1 Rose Tyler (WHO) 5\n1 The Tenth Doctor (WHO) 3\n1 Sol Ring (WHO) 245\n…'}
          onChange={e => appActions.setDeckText(e.target.value)}
        />
```

- [ ] **Step 5: Style the new elements**

Append to `client/src/styles.css`:

```css
/* Deck warnings are advisory — the deck is valid and startable. Distinct from
   .deck-problems, which is fatal. */
.deck-warnings {
  margin: 0.25rem 0 0;
  padding-left: 1.1rem;
  color: var(--warn, #b8860b);
  font-size: 0.85em;
}

.deck-format {
  opacity: 0.65;
  font-style: normal;
}

.deck-hint {
  margin: 0 0 0.4rem;
  opacity: 0.75;
  font-size: 0.9em;
}
```

- [ ] **Step 6: Typecheck and build**

Run: `cd client && npm run build`
Expected: no TypeScript errors. A complaint about `seat.deck.format` means Task 11 step 5 was
skipped.

- [ ] **Step 7: Run the client test suite**

Run: `cd client && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src
git commit -m "Deck import: client sends auto, renders detected format and warnings"
```

---

### Task 14: Deployment and documentation

**Files:**
- Modify: `deploy/night-bridge.service:24`
- Modify: `deploy/README.md`
- Modify: `docs/bridge/design.md:267` (§9 deck bullet), `:374` (the index-drift risk), `:62` + `:77` (repo layout)
- Modify: `CLAUDE.md`

**Interfaces:** none — documentation and configuration only.

- [ ] **Step 1: Raise the bridge heap**

In `deploy/night-bridge.service`, change `-Xmx512m` to:

```
    -Xmx1536m \
```

- [ ] **Step 2: Document the card-database symlink**

In `deploy/README.md`, add a section after the systemd-unit installation steps:

```markdown
### Card database access (deck import)

The bridge resolves deck card names through XMage's own card database. `CardRepository`
hardcodes the relative path `./db/cards.h2`, so the bridge's working directory needs a symlink:

```sh
sudo ln -sfn /opt/commander-night/xmage-dist/xmage/mage-server/db /var/lib/commander-night/db
sudo chown -h night-bridge:night-bridge /var/lib/commander-night/db
```

The database is opened in H2 mixed mode (`AUTO_SERVER=TRUE`), so the bridge and the game server
may hold it at the same time; start order does not matter.

The bridge refuses to start if the table is missing or implausibly small. That guard is
deliberate: `CardRepository`'s constructor drops and rebuilds the card table when it thinks the
jar is newer than the database, and only the game server's set scanner can repopulate it. If you
hit the guard, start the XMage server once and let it rebuild, then start the bridge.
```

- [ ] **Step 3: Update the bridge design document**

In `docs/bridge/design.md`, replace the `**Decks** (`lobby.deck`)` bullet in §9:

```markdown
- **Decks** (`lobby.deck`): three formats per protocol §5, auto-detected. `.dck` parses as in the
  spike (`[SET:NUM] Name`, `SB:` = commander). Moxfield exports (`N Name (SET) NUM`) lead with
  their commanders and may carry `SIDEBOARD:`/`PLANES:` sections, which are discarded with a
  warning. MTGO lists (`N Name`) carry no printing at all and keep the commander in a trailing
  stanza; names resolve through the pinned server's card database via
  `CardRepository.findPreferredCoreExpansionCard` — XMage's own choice of printing, so ours match
  its client's by construction. A missed set or collector number downgrades to a different
  printing of the same card plus a warning; only a missed name is fatal. Partner pairs are
  detected with XMage's own `mage.util.validation.CommanderValidator`s. Bridge pre-validates
  main+SB = 100 and commander-in-sideboard for friendlier errors than XMage's joinTable rejection.
  Implementation: `night.bridge.lobby.deck`, spec
  `docs/superpowers/specs/2026-07-20-deck-import-formats-design.md`.
```

Delete the `**Card-name index drift**` risk bullet at §15 entirely — live lookup cannot drift.

In §3's repo layout, replace the `DeckParser.java` line with:

```
               deck/               # DeckImporter facade: sniffer, 3 line parsers,
                                   # CardResolver (the only card-db consumer), assembler
```

and delete the `src/main/resources/cards-index.tsv` line — no index is generated.

- [ ] **Step 4: Correct the stale OOM note in CLAUDE.md**

In `CLAUDE.md`, in the local-XMage-server command comment, replace the parenthetical justification:

```sh
# local XMage server — startServer.sh may lack +x; equivalent. 2048m matches prod:
(cd vendor/xmage-dist/xmage/mage-server && ../../java/jre1.8.0_201/bin/java -Xmx2048m -jar lib/mage-server-1.4.60.jar)
```

The "1024m OOM'd in AI simulations" note described the decommissioned 2 GiB host and is not a
sizing signal for the current 8 GiB one.

- [ ] **Step 5: Note the local symlink in CLAUDE.md commands**

In `CLAUDE.md`, after the `install-xmage-jars.sh` entry, add:

```sh
ln -sfn vendor/xmage-dist/xmage/mage-server/db db   # one-time: deck import reads XMage's
                                                    # card db through a hardcoded ./db path
```

- [ ] **Step 6: Verify the deployable build still assembles**

Run: `cd bridge && mvn -Pdist -DskipTests package`
Expected: BUILD SUCCESS, and `target/lib/` now contains `h2-1.4.197.jar`, `ormlite-core-5.7.jar`
and `ormlite-jdbc-5.7.jar`.

- [ ] **Step 7: Commit**

```bash
git add deploy/ docs/bridge/design.md CLAUDE.md
git commit -m "Deck import: deployment, heap, and design-doc updates"
```

---

### Task 15: End-to-end acceptance

Nothing has yet proved a pasted Moxfield or MTGO deck actually plays. `MultiHumanLiveTest` is the
only live test that goes through `lobby.deck` (`:109`, `:115`); `LiveGameTest` seats decks
directly from the sample directory and never touches the lobby, so it is **not** the right place.

Rather than add a second ten-minute live test, convert the existing one: Alice pastes Moxfield,
Bob pastes MTGO. Both new code paths then run through the real lobby → `joinTable` → full game →
rematch sequence that is already green, and there is no new test to maintain.

**Files:**
- Modify: `bridge/src/test/java/night/bridge/live/MultiHumanLiveTest.java:108-115`

**Interfaces:**
- Consumes: `Fixtures.read` (Task 2, made public there).

- [ ] **Step 1: Swap the deck submissions**

In `MultiHumanLiveTest.java`, replace lines 108-115's deck handling. The existing code reads:

```java
        String deck = Files.readString(LiveHarness.SAMPLE_DECK);
        alice.awaitAck("deck", alice.send("lobby.deck", Map.of("format", "dck", "content", deck)));
        // ... bob's join ...
        bob.awaitAck("deck", bob.send("lobby.deck", Map.of("format", "dck", "content", deck)));
```

Replace the two `send` calls (keep everything between them untouched) with:

```java
        // Deck import acceptance: the two new formats play a real game, auto-detected.
        // Alice's list is a partner pair, which only the card database can identify.
        String moxfield = Fixtures.read("timey_wimey.moxfield");
        String mtgo = Fixtures.read("counter_intelligence.mtgo");
        alice.awaitAck("deck", alice.send("lobby.deck", Map.of("format", "auto", "content", moxfield)));
        // ... bob's join stays as it is ...
        bob.awaitAck("deck", bob.send("lobby.deck", Map.of("format", "auto", "content", mtgo)));
```

Add the import `import night.bridge.lobby.deck.Fixtures;` and drop the now-unused
`Files.readString(LiveHarness.SAMPLE_DECK)` line if nothing else uses it (leave
`LiveHarness.SAMPLE_DECK` itself alone — other tests use it).

- [ ] **Step 2: Assert the lobby reported what we expect**

After the second ack, before the seats ready up, add:

```java
        // The lobby must show auto-detection worked and the partner pair was found,
        // otherwise the game below would still start and silently prove nothing.
        var lobbyState = alice.awaitEvent("lobby.state",
                e -> e.at("/seats/0/deck/valid").asBoolean(false));
        assertEquals("moxfield", lobbyState.at("/seats/0/deck/format").asText());
        assertEquals(100, lobbyState.at("/seats/0/deck/cards").asInt());
        assertEquals(2, lobbyState.at("/seats/0/deck/commander").size(),
                "Rose Tyler + The Tenth Doctor should be detected as a partner pair");
```

If `awaitEvent` has a different name or signature in this harness, match the existing calls in
this file rather than inventing one — read the surrounding code first.

- [ ] **Step 3: Run it**

Run: `cd bridge && mvn -Plive test -Dtest=MultiHumanLiveTest`
Expected: PASS (this test runs roughly 10 minutes). A `joinTable` failure means a resolved
printing is not a real card — fix `CardResolver`, since XMage looks up strictly by set + number
and a bad pick only surfaces here.

- [ ] **Step 4: Full live tier**

Run: `cd bridge && mvn -Plive test`
Expected: BUILD SUCCESS across every live test.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/test/java/night/bridge/live/MultiHumanLiveTest.java
git commit -m "Deck import: live acceptance via pasted Moxfield and MTGO decks"
```

---

## Verification checklist

Before calling this done:

- [ ] `cd bridge && mvn test` — BUILD SUCCESS
- [ ] `cd bridge && mvn -Plive test` — BUILD SUCCESS (XMage server running)
- [ ] `cd client && npm run build && npm test` — clean
- [ ] All six sample decks import to exactly 100 cards with no problems
- [ ] `timey_wimey` yields two commanders in **both** formats
- [ ] `counter_intelligence` and `timey_wimey` each report exactly one discarded-section warning
- [ ] `git grep -n DeckParser` returns nothing
- [ ] `git grep -n "cards-index"` returns nothing
