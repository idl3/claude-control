import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Plugin } from 'vite';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

// Same media-serving contract as ../pin-to-panel-harness/vite.config.mts —
// serves the real, already-built artifacts-landing.html and
// pipeline-dashboard.html (create-artifact skill output, both html/react
// lanes that emit width="wide") at the /api/media/apps/<name>.html path
// resolveMediaUrl's 'fetch' branch requests for this harness's
// <EmbeddedApp url="apps/<name>.html" /> instances.
function artifactMedia(): Plugin {
  const files: Record<string, string> = {
    '/api/media/apps/artifacts-landing.html': 'artifacts-landing.html',
    '/api/media/apps/pipeline-dashboard.html': 'pipeline-dashboard.html',
  };
  return {
    name: 'wide-embeds-artifact-media',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        const match = Object.keys(files).find((k) => url.startsWith(k));
        if (match) {
          const appHtml = readFileSync(join(homedir(), '.claude-control', 'media', 'apps', files[match]));
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
  plugins: [react(), artifactMedia()],
  server: { fs: { allow: [repoRoot] } },
});
