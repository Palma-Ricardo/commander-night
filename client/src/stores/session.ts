// session store (design §4) — token/identity, display name, deck text, resume
// anchor. Written by net/session and lobby actions.

import { createStore } from 'zustand/vanilla';
import { KEYS, type KV } from './storage';

export interface ResumeAnchor { gameId: string; lastSeq: number }

export interface SessionState {
  token?: string;
  userId?: string;
  name: string;                // display name, persisted
  deckText: string;            // persisted deck text (protocol §5: clients hold it)
  resume?: ResumeAnchor;
}

export const createSessionStore = (kv: KV) =>
  createStore<SessionState>(() => {
    let resume: ResumeAnchor | undefined;
    const raw = kv.get(KEYS.resume);
    if (raw !== null) {
      try {
        resume = JSON.parse(raw) as ResumeAnchor;
      } catch {
        kv.remove(KEYS.resume);
      }
    }
    return {
      token: kv.get(KEYS.token) ?? undefined,
      name: kv.get(KEYS.name) ?? '',
      deckText: kv.get(KEYS.deck) ?? '',
      resume,
    };
  });
