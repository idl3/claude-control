/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built for claude-cockpit's Node server, which serves this from web/dist.
// base: '/' (absolute asset URLs) is required for path-based routing
// (/<session>/<window>/<pane>): a relative base would resolve /assets against
// the deep path and 404. `tailscale serve` maps the tailnet host root to the
// server root (see bin/install-service.sh), so absolute asset paths are fine.
// The server serves index.html for unknown non-asset paths (SPA fallback).
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
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
