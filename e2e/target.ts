// Which client this run drives (T5). The specs are client-agnostic — they express
// game intent through the semantic harness (§12) and touch DOM only for the
// chrome both clients render identically — so the only thing that changes between
// a classic run and a table run is the baseURL.
//
// From the repo root:
//   npm run e2e:table              →  the table client's dev server    (5273)
//   npm run e2e:classic            →  the classic client's dev server  (5173)
//   npm run e2e:table:preview      →  the built harness bundle behind `vite preview`
//   npm run e2e:classic:preview    →  ...the classic one (4173)
//
// NIGHT_BASE_URL overrides everything (a deployed host, a different port).

import { fileURLToPath } from 'node:url';

export type Target = 'classic' | 'table' | 'classic-preview' | 'table-preview';

const DEFAULT_URL: Record<Target, string> = {
  classic: 'http://localhost:5173',
  table: 'http://localhost:5273',
  'classic-preview': 'http://localhost:4173',
  'table-preview': 'http://localhost:4273',
};

export const TARGET = (process.env['NIGHT_CLIENT'] ?? 'classic') as Target;

if (DEFAULT_URL[TARGET] === undefined) {
  throw new Error(`NIGHT_CLIENT must be one of ${Object.keys(DEFAULT_URL).join(', ')} — got ${TARGET}`);
}

/** Which client, ignoring dev-vs-preview. */
export const CLIENT: 'classic' | 'table' = TARGET.startsWith('table') ? 'table' : 'classic';

export const BASE_URL = process.env['NIGHT_BASE_URL'] ?? DEFAULT_URL[TARGET];

/** Screenshots land per client, so a table run never overwrites a classic one.
 *  Resolved from this file, not the cwd — the same specs are launched from the repo
 *  root (`npm run e2e:table`) and from `e2e/` (the workspace script), and a relative
 *  path quietly produced `e2e/e2e/artifacts/` from the latter. */
export const SHOTS = process.env['NIGHT_SHOT_DIR']
  ?? fileURLToPath(new URL(`./artifacts/${CLIENT}`, import.meta.url));
