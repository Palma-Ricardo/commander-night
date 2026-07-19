// notices store (design §11) — toast queue for unsolicited non-fatal errors
// and protocol-layer explanations (e.g. RESUME_FAILED after teardown). Written
// by net/route; the Toaster component only reads, dismissal goes through the
// dismissNotice action.

import { createStore } from 'zustand/vanilla';

export interface Notice {
  id: number;
  kind: 'error' | 'info';
  text: string;
}

export interface NoticesState { toasts: Notice[] }

let nextNoticeId = 1;

export const createNoticesStore = () => createStore<NoticesState>(() => ({ toasts: [] }));

type NoticesStore = ReturnType<typeof createNoticesStore>;

export function pushNotice(store: NoticesStore, kind: Notice['kind'], text: string): number {
  const id = nextNoticeId++;
  store.setState(s => ({ toasts: [...s.toasts, { id, kind, text }] }));
  return id;
}

export function dismissNotice(store: NoticesStore, id: number): void {
  store.setState(s => ({ toasts: s.toasts.filter(t => t.id !== id) }));
}
