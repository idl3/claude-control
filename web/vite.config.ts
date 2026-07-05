/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built for claude-cockpit's Node server, which serves this from web/dist.
// base: './' keeps asset URLs relative so it loads behind `tailscale serve`
// or any sub-path. Everything is bundled — no runtime CDN calls.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    // Emit source maps so a client crash logged to /api/client-error carries a
    // readable stack (function names + source lines) instead of minified offsets.
    // Personal tool on localhost/tailnet — exposing source is a non-issue.
    sourcemap: true,
  },
  // Unit tests run in a plain Node env (no jsdom): convert.ts is pure, and the
  // ws.ts tests stub a minimal WebSocket on globalThis. Deterministic + fast.
  // Files use the `.vitest.ts` suffix (not `.test.ts`) so the repo-root
  // `node --test` runner — which globs **/*.test.ts — never tries to execute
  // these TS-with-vitest files. The two runners stay fully isolated.
  test: {
    environment: 'node',
    include: ['src/**/*.vitest.ts'],
  },
});
