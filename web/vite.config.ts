/// <reference types="vitest/config" />
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Built for claude-cockpit's Node server, which serves this from web/dist.
// base: './' keeps asset URLs relative so it loads behind `tailscale serve`
// or any sub-path. Everything is bundled — no runtime CDN calls.
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      // lib/protocol/ — the versioned wire-protocol schemas (plain JS + zod,
      // no build step at the repo root; see lib/protocol/index.js). The web
      // app imports the SAME schema modules the backend runs and derives its
      // TS types from them with `z.infer` instead of hand-duplicating shapes.
      '@protocol': path.resolve(__dirname, '../lib/protocol'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    // Emit source maps so a client crash logged to /api/client-error carries a
    // readable stack (function names + source lines) instead of minified offsets.
    // Personal tool on localhost/tailnet — exposing source is a non-issue.
    sourcemap: true,
  },
  // Unit tests run in a plain Node env (no jsdom) by default: convert.ts is
  // pure, and the ws.ts tests stub a minimal WebSocket on globalThis.
  // Individual files opt into jsdom via a `// @vitest-environment jsdom`
  // pragma (e.g. ccBridgeRuntime.vitest.ts). Files use the `.vitest.ts`
  // suffix (not `.test.ts`) so the repo-root `node --test` runner — which
  // globs **/*.test.ts — never tries to execute these TS-with-vitest files.
  // The two runners stay fully isolated.
  //
  // C4: `scratch/**/*.vitest.ts` is included alongside `src/**/*.vitest.ts`
  // so a dogfood's OWN test file (e.g. scratch/counter-app/counter.vitest.ts)
  // can import and exercise its real component + withCcBridge wiring
  // in-place — this repo's own established "no Playwright, jsdom+RTL proves
  // live prop-driven re-render" verification tier (see
  // ccBridgeRuntime.vitest.ts), extended to the actual dogfood components
  // rather than a generic fixture.
  test: {
    environment: 'node',
    include: ['src/**/*.vitest.ts', 'scratch/**/*.vitest.ts'],
    // The suite is broad enough that Vitest's CPU-count default can spawn a
    // dozen Vite/esbuild workers, amplifying memory pressure on the same host
    // that runs the cockpit and agent sessions. Two workers proved faster and
    // substantially leaner under load.
    minWorkers: 1,
    maxWorkers: 2,
  },
});
