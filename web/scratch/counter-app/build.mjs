#!/usr/bin/env node
// Builds the single-file counter micro-app, versioned + manifested via the
// prototype-component skill's run.mjs CLI (apps/counter/<stamp>.html + a
// apps/counter.html flat compat alias + a sibling <stamp>.manifest.json —
// see lib/media-apps.js's doc comment for the layout, and run.mjs's own
// `--infer-manifest`/`--write-app` doc comments, which name THIS file as
// their intended caller) — the demo target for the
// <embedded-app url="apps/counter.html" height="…" /> transcript tag AND for
// cockpit-prototype-studio's Props tab (C3), which drives Counter's props
// live via the withCcBridge wrapper counter.tsx applies (C4).
//
// Bundles React + ReactDOM + counter.tsx into one minified IIFE (esbuild,
// resolved from web/node_modules — this dir has no node_modules of its own)
// and inlines it directly into a <script> tag alongside inline <style>. This
// is load-bearing, not a style choice: the artifact is loaded via
// `srcDoc` on a sandboxed iframe, which has no base URL, so an external
// <script src> or <link rel=stylesheet> would silently fail to load.
//
// Usage: node build.mjs   (run from anywhere; paths are resolved from this
// file's own location, not cwd)
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const dir = path.dirname(fileURLToPath(import.meta.url));
const RUN_MJS = path.join(os.homedir(), '.claude', 'skills', 'prototype-component', 'scripts', 'run.mjs');

const result = await build({
  entryPoints: [path.join(dir, 'counter.tsx')],
  bundle: true,
  minify: true,
  format: 'iife',
  jsx: 'automatic',
  target: ['es2019'],
  // React reads process.env.NODE_ENV at import time to pick dev vs prod code
  // paths; the browser has no `process` global, so without this define the
  // bundle would throw a ReferenceError on load. Baking it in at build time
  // also drops React's dev-only warning/check code from the minified output.
  define: { 'process.env.NODE_ENV': '"production"' },
  write: false,
  logLevel: 'silent',
});

// Defensive: escape a literal "</script" if it ever appeared inside the
// bundle (e.g. inside a minified string constant) so it can never
// early-close the wrapping <script> tag.
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const css = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    display: grid;
    place-items: center;
    min-height: 100vh;
    background: #0d1017;
    color: #e6e9ef;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .counter-card {
    text-align: center;
    padding: 22px 30px;
    border: 1px solid #2a3040;
    border-radius: 12px;
    background: #161b26;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  }
  .counter-label { font-size: 12px; color: #9aa4b8; letter-spacing: 0.02em; }
  .count {
    font-size: 44px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    margin: 6px 0 16px;
  }
  .counter-actions { display: flex; gap: 8px; justify-content: center; }
  button {
    font: inherit;
    color: #e6e9ef;
    background: #232b3b;
    border: 1px solid #3b465c;
    border-radius: 8px;
    padding: 6px 16px;
    cursor: pointer;
  }
  button:hover { background: #2c3650; border-color: #4a5674; }
  button:focus-visible { outline: 2px solid #5b8cff; outline-offset: 1px; }
  button.danger { border-color: #f8514966; color: #ffa198; }
  button.danger:hover { background: #f851491a; }
  .crash-fallback {
    border: 1px solid #f8514966;
    background: #f851491a;
    color: #ffa198;
    border-radius: 12px;
    padding: 20px 26px;
    max-width: 320px;
    text-align: center;
  }
  .crash-title { font-weight: 600; margin-bottom: 8px; }
  .crash-fallback code { font-size: 12px; opacity: 0.8; word-break: break-word; }
`.trim();

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>counter micro-app</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`;

// Docgen + versioning both go through run.mjs's own CLI surfaces (not
// duplicated here) — infer a manifest for the `Counter` component (the sole
// docgen-visible export in counter.tsx, see that file's doc comment), then
// version the built HTML with that manifest as a sibling. Both degrade
// loudly-but-non-fatally on failure (run.mjs's own contract: docgen/manifest
// problems never block the HTML build) — this script only fails outright if
// the HTML itself can't be written/versioned.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'counter-build-'));
try {
  const htmlPath = path.join(tmp, 'counter.html');
  writeFileSync(htmlPath, html, 'utf8');

  const manifestPath = path.join(tmp, 'counter.manifest.json');
  execFileSync(
    process.execPath,
    [RUN_MJS, '--infer-manifest', path.join(dir, 'counter.tsx'), '--out', manifestPath],
    { stdio: 'inherit' },
  );

  execFileSync(process.execPath, [RUN_MJS, '--write-app', 'counter', '--html', htmlPath, '--manifest', manifestPath], {
    stdio: 'inherit',
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
