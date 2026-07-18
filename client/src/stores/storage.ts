// Thin key-value layer over localStorage (design §12: all keys under `cn.`).
// Injected everywhere (stores, net) so tests and headless runs use a memory map;
// the browser build uses localStorage via browserKV().

export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export const KEYS = {
  token: 'cn.token',
  name: 'cn.name',
  deck: 'cn.deck',
  resume: 'cn.resume',
  settings: 'cn.settings',
} as const;

export function memoryKV(): KV {
  const m = new Map<string, string>();
  return {
    get: k => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
    remove: k => void m.delete(k),
  };
}

export function browserKV(): KV {
  if (typeof localStorage === 'undefined') return memoryKV();
  return {
    get: k => localStorage.getItem(k),
    set: (k, v) => localStorage.setItem(k, v),
    remove: k => localStorage.removeItem(k),
  };
}
