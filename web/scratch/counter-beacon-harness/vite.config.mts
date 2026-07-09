import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Plugin } from 'vite';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

// Same real, just-rebuilt artifact churn-spike serves (identical path
// contract) — but THIS harness cares that it's the post-B3 build carrying
// the cc-app-error beacon in its ErrorBoundary, not churn-spike's copy at
// the time it ran. Re-reading the file at request time (not import time)
// means a re-run always picks up whatever `node build.mjs` last wrote.
function proofMedia(): Plugin {
  return {
    name: 'counter-beacon-proof-media',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (url.startsWith('/api/media/proof/app.html')) {
          const appHtml = readFileSync(join(homedir(), '.claude-control', 'media', 'apps', 'counter.html'));
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
