// The live browser tier (design §12). Assumes XMage + the bridge are already
// running, plus whichever client server the target names:
//
//   cd client && npm run dev            → NIGHT_CLIENT=classic         (default)
//   cd table  && npm run dev            → NIGHT_CLIENT=table
//   cd client && npm run preview:harness → NIGHT_CLIENT=classic-preview
//   cd table  && npm run preview:harness → NIGHT_CLIENT=table-preview
//
// From the repo root: `npm run e2e:table` (etc.) — see e2e/package.json.
import { defineConfig } from '@playwright/test';
import { BASE_URL, TARGET } from './target';

export default defineConfig({
  testDir: '.',
  timeout: 240_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: BASE_URL },
  metadata: { target: TARGET },
});
