// Log/chat panel (§8): tabbed, seq-ordered entries with kind styling; `refs`
// become hover links to card previews (when the object is still in visible
// state). The chat tab renders only the game.log echo (§4 — never a local
// copy), carries the unread badge, and owns the chat input; chat stays live
// through post-game teardown grace (§10).

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { appActions, appStores } from '../../app';
import type { GameState, LogEntry } from '@night/core/protocol/protocol';
import { findObject, playerName, rematchCode } from '@night/core/state/selectors';
import { hoverCard } from '../hover';

export function LogPanel({ state }: { state: GameState }) {
  const entries = useStore(appStores.log, s => s.entries);
  const unread = useStore(appStores.log, s => s.unreadChat);
  const [tab, setTab] = useState<'log' | 'chat'>('log');
  const listRef = useRef<HTMLOListElement>(null);
  const stickBottom = useRef(true);

  const shown = tab === 'log' ? entries : entries.filter(e => e.kind === 'chat');

  useEffect(() => {
    const el = listRef.current;
    if (el !== null && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, tab]);

  useEffect(() => {
    if (tab === 'chat' && unread > 0) appActions.markChatRead();
  }, [tab, unread]);

  const onScroll = () => {
    const el = listRef.current;
    if (el !== null) stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <aside className="log-panel">
      <div className="log-tabs">
        <button className={tab === 'log' ? 'tab tab-active' : 'tab'} onClick={() => setTab('log')}>
          Log
        </button>
        <button className={tab === 'chat' ? 'tab tab-active' : 'tab'} onClick={() => setTab('chat')}>
          Chat
          {unread > 0 && <span className="chat-unread">{unread}</span>}
        </button>
      </div>
      <ol ref={listRef} onScroll={onScroll} className="log-entries">
        {shown.map(e => (
          <li key={e.seq} className={`log-${e.kind}`}>
            {e.turn !== undefined && <span className="log-turn">{e.turn}</span>}
            {e.kind === 'chat' && <b className="log-speaker">{playerName(state, e.playerId)}: </b>}
            {e.kind === 'personal' && <span title="only you see this">🕵 </span>}
            <LogText entry={e} state={state} />
          </li>
        ))}
      </ol>
      <ChatInput />
    </aside>
  );
}

function ChatInput() {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const send = () => {
    const t = text.trim();
    if (t === '') return;
    setText('');
    setError(null);
    appActions.sendChat(t).catch((e: Error) => setError(e.message));
  };

  return (
    <div className="chat-input">
      <input
        value={text}
        maxLength={500}
        placeholder="table chat…"
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') send(); }}
      />
      <button disabled={text.trim() === ''} onClick={send}>Send</button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Over-banner affordance data (§10): the latest rematch invite in chat. */
export function useRematchCode(): string | undefined {
  return useStore(appStores.log, s => rematchCode(s.entries));
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
        onMouseEnter={card !== undefined ? (e: ReactMouseEvent<HTMLSpanElement>) => {
          const r = e.currentTarget.getBoundingClientRect();
          hoverCard(card, { left: r.left, top: r.top, width: r.width, height: r.height });
        } : undefined}
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
