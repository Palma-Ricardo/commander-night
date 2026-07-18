// Ad-hoc browser tier for C1/C2 (grows into the §13 auto-player at C3).
// Assumes XMage + bridge + `npm run dev` are already running:
//   npx playwright test
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/pw',
  timeout: 240_000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5173',
  },
});
