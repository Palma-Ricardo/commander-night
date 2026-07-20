import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Dev-mode bridge proxy (design §1): same-origin /ws → the local bridge.
      '/ws': { target: 'ws://127.0.0.1:8484', ws: true },
    },
  },
  preview: {
    proxy: {
      // `vite preview` doesn't inherit the `server` proxy above — the C5
      // built-bundle smoke tier needs its own, mirroring what caddy does in
      // production (Task 10).
      '/ws': { target: 'ws://127.0.0.1:8484', ws: true },
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
