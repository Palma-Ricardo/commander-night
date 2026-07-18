// Log panel (§8): seq-ordered entries with kind styling; `refs` become hover
// links to card previews (when the object is still in visible state). Chat
// input is C4 — chat lines already render via their `game.log` echo.

import { useEffect, useRef, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { appStores } from '../../app';
import type { GameState, LogEntry } from '../../protocol/protocol';
import { findObject, playerName } from '../../state/selectors';
import { hoverCard } from '../hover';

export function LogPanel({ state }: { state: GameState }) {
  const entries = useStore(appStores.log, s => s.entries);
  const listRef = useRef<HTMLOListElement>(null);
  const stickBottom = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (el !== null && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  const onScroll = () => {
    const el = listRef.current;
    if (el !== null) stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <aside className="log-panel">
      <h3>Log</h3>
      <ol ref={listRef} onScroll={onScroll} className="log-entries">
        {entries.map(e => (
          <li key={e.seq} className={`log-${e.kind}`}>
            {e.turn !== undefined && <span className="log-turn">{e.turn}</span>}
            {e.kind === 'chat' && <b className="log-speaker">{playerName(state, e.playerId)}: </b>}
            {e.kind === 'personal' && <span title="only you see this">🕵 </span>}
            <LogText entry={e} state={state} />
          </li>
        ))}
      </ol>
    </aside>
  );
}

/** Wrap each ref's first occurrence in the line as a hover link (§8). */
function LogText({ entry, state }: { entry: LogEntry; state: GameState }) {
  const refs = entry.refs ?? [];
  if (refs.length === 0) return <>{entry.text}</>;

  const marks: { start: number; end: number; objectId: string; name: string }[] = [];
  for (const r of refs) {
    if (r.name === '') continue;
    const i = entry.text.indexOf(r.name);
    if (i >= 0) marks.push({ start: i, end: i + r.name.length, objectId: r.objectId, name: r.name });
  }
  marks.sort((a, b) => a.start - b.start);

  const nodes: ReactNode[] = [];
  let pos = 0;
  for (const m of marks) {
    if (m.start < pos) continue;   // overlapping/duplicate refs
    if (m.start > pos) nodes.push(entry.text.slice(pos, m.start));
    const card = findObject(state, m.objectId);
    nodes.push(
      <span
        key={`${m.objectId}-${m.start}`}
        className="log-ref"
        onMouseEnter={card !== undefined ? () => hoverCard(card) : undefined}
        onMouseLeave={card !== undefined ? () => hoverCard(undefined) : undefined}
      >
        {m.name}
      </span>,
    );
    pos = m.end;
  }
  if (pos < entry.text.length) nodes.push(entry.text.slice(pos));
  return <>{nodes}</>;
}
