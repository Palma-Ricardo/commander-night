import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The table client — a second static SPA alongside the classic client (design
// §2). Same shape: caddy serves dist/ with /ws proxied to the bridge. Dev port
// 5273 keeps it clear of the classic client's 5173 so both can run at once.
export default defineConfig({
  server: {
    port: 5273,
    proxy: { '/ws': { target: 'ws://127.0.0.1:8484', ws: true } },
  },
  preview: {
    proxy: { '/ws': { target: 'ws://127.0.0.1:8484', ws: true } },
  },
  plugins: [react()],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
