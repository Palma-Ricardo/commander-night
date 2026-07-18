// Live-tier config (design §13) — excluded from `npm test`, mirrors the bridge's
// `-Plive` split. Run from client/ with a bridge (and for the proxy path,
// `npm run dev`) up:
//   npx vitest run --config e2e/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.live.test.ts'],
  },
});
