// C5 built-bundle smoke: the C3 auto-player, run against the real production
// bundle instead of the dev server. This is the only tier that exercises the
// built output — tree-shaking, env resolution, and asset paths all differ from
// dev, and the night runs on the built bundle.
//
// Assumes XMage + bridge are running, plus `npm run preview:harness`.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/pw',
  testMatch: 'autoplayer.spec.ts',
  timeout: 240_000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:4173',
  },
});
