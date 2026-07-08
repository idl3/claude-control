#!/usr/bin/env node
// Builds the single-file counter micro-app deployed to
// ~/.claude-control/media/apps/counter.html — the demo target for the
// <embedded-app url="apps/counter.html" height="…" /> transcript tag.
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
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const dir = path.dirname(fileURLToPath(import.meta.url));

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

const outDir = path.join(os.homedir(), '.claude-control', 'media', 'apps');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'counter.html');
writeFileSync(outFile, html, 'utf8');
console.log(`wrote ${outFile} (${html.length} bytes total, ${js.length} bytes js)`);
