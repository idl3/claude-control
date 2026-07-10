#!/usr/bin/env node
// Builds the single-file composer micro-app, versioned + manifested via the
// prototype-component skill's run.mjs CLI — same pattern as
// web/scratch/counter-app/build.mjs (see that file's doc comment for the
// full rationale: single-file esbuild IIFE, docgen + --write-app both
// delegated to run.mjs, never duplicated here). Second dogfood target for
// cockpit-prototype-studio's Props tab (C4), proving the manifest/bridge
// wiring generalizes past the counter demo.
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
  entryPoints: [path.join(dir, 'composer.tsx')],
  bundle: true,
  minify: true,
  format: 'iife',
  jsx: 'automatic',
  target: ['es2019'],
  define: { 'process.env.NODE_ENV': '"production"' },
  write: false,
  logLevel: 'silent',
});

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
  .composer-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 320px;
    padding: 18px;
    border: 1px solid #2a3040;
    border-radius: 12px;
    background: #161b26;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  }
  .composer-log {
    min-height: 80px;
    max-height: 160px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .composer-log-empty { font-size: 12px; color: #6b7488; }
  .composer-log-entry {
    font-size: 13px;
    padding: 6px 10px;
    border-radius: 8px;
    background: #1f2634;
    align-self: flex-start;
  }
  .composer-row { display: flex; gap: 8px; }
  .composer-input {
    flex: 1;
    font: inherit;
    color: #e6e9ef;
    background: #0d1017;
    border: 1px solid #3b465c;
    border-radius: 8px;
    padding: 8px 10px;
  }
  .composer-input:disabled { opacity: 0.5; }
  .composer-input:focus-visible { outline: 2px solid #5b8cff; outline-offset: 1px; }
  button {
    font: inherit;
    color: #e6e9ef;
    background: #232b3b;
    border: 1px solid #3b465c;
    border-radius: 8px;
    padding: 8px 16px;
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: #2c3650; border-color: #4a5674; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button:focus-visible { outline: 2px solid #5b8cff; outline-offset: 1px; }
  .composer-session { font-size: 11px; color: #6b7488; }
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
<title>composer micro-app</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`;

const tmp = mkdtempSync(path.join(os.tmpdir(), 'composer-build-'));
try {
  const htmlPath = path.join(tmp, 'composer.html');
  writeFileSync(htmlPath, html, 'utf8');

  const manifestPath = path.join(tmp, 'composer.manifest.json');
  execFileSync(
    process.execPath,
    [RUN_MJS, '--infer-manifest', path.join(dir, 'composer.tsx'), '--out', manifestPath],
    { stdio: 'inherit' },
  );

  execFileSync(
    process.execPath,
    [RUN_MJS, '--write-app', 'composer', '--html', htmlPath, '--manifest', manifestPath],
    { stdio: 'inherit' },
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
