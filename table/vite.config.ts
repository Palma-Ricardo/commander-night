import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The table client — a second static SPA alongside the classic client (design
// §2). Same shape: caddy serves dist/ with /ws proxied to the bridge. Dev port
// 5273 keeps it clear of the classic client's 5173 so both can run at once.
export default defineConfig({
  // The root `overrides` pin (react 19.2.7, design T0) keeps react/react-dom in
  // each workspace's own node_modules rather than hoisted, while zustand hoists to
  // the root. Without dedupe, bundling the root's zustand leaves its `import
  // 'react'` unresolvable (root has no react) and the built bundle throws at load.
  // dedupe resolves both to this package's single copy.
  resolve: { dedupe: ['react', 'react-dom'] },
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
