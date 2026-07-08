import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Plugin } from 'vite';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

// The real prototype-component app template — same bytes the skill emits, so
// EmbeddedApp's real authFetch → srcDoc → sandboxed-iframe path is exercised
// against genuine app HTML, not a synthetic stub.
const appHtml = readFileSync(join(homedir(), '.claude-control', 'media', 'apps', 'counter.html'));

// Serves the one app URL both churn-spike threads embed
// (/api/media/proof/app.html) through the same relative-path → /api/media/
// fetch contract EmbeddedApp uses in the real app (see lib/mediaUrl.ts).
// Any other /api/media/* 404s (unused by this harness, kept for parity with
// the prototype-cockpit-uiproof pattern this harness copies).
function proofMedia(): Plugin {
  return {
    name: 'churn-spike-proof-media',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (url.startsWith('/api/media/proof/app.html')) {
          res.setHeader('Content-Type', 'text/html');
          res.end(appHtml);
          return;
        }
        if (url.startsWith('/api/media/')) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), proofMedia()],
  server: { fs: { allow: [repoRoot] } },
});
