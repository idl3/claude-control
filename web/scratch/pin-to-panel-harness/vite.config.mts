import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Plugin } from 'vite';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

// Same media-serving contract as ../counter-beacon-harness/vite.config.mts —
// serves the real, already-built counter.html (see ../counter-app/build.mjs)
// at the /api/media/apps/counter.html path resolveMediaUrl's 'fetch' branch
// requests for the bare `apps/counter.html` url this harness's
// <embedded-app> tags use. Also aliases the SAME built file under
// apps/counter2.html — a second independent artifact id/tab (both count
// from 0 independently, since each is its own iframe with its own React
// root) is the cheapest way to get a real tab-switch scenario for the C4
// capture without a second build target.
function counterMedia(): Plugin {
  return {
    name: 'pin-to-panel-counter-media',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (url.startsWith('/api/media/apps/counter.html') || url.startsWith('/api/media/apps/counter2.html')) {
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
  plugins: [react(), counterMedia()],
  server: { fs: { allow: [repoRoot] } },
});
