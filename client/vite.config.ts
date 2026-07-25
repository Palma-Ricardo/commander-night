import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The T0 workspace extraction left react/react-dom pinned inside each package
  // (root `overrides`) while zustand hoisted to the repo root, so bundling the
  // root's zustand leaves its `import 'react'` unresolvable — the root has no
  // react. The table client hit this at T0 and fixed it here; the classic client
  // needed the same line and never got it, and rolldown does not fail the build
  // over it: it emits a top-level `throw Error("Could not resolve \"react\"
  // imported by \"zustand\"")` and drops everything after it, so `npm run build`
  // quietly produced a bundle with no UI at all (caught at T5, 2026-07-24, by
  // grepping the built output for its own class names and finding none).
  resolve: { dedupe: ['react', 'react-dom'] },
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
