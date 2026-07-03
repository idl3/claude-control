/**
 * lib/client-errors.js — server-side sink for FRONTEND crashes.
 *
 * The web app POSTs render crashes (ErrorBoundary), uncaught window errors, and
 * unhandled promise rejections to /api/client-error; this appends each as one
 * JSONL line to ~/.claude-control/logs/client-errors.jsonl so every client crash
 * is logged, traceable (full stack + url + UA + session), and fixable from the
 * server without needing to reproduce it live.
 *
 * Fields are clipped and the file self-rotates so a crash loop can't fill the disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MAX_FIELD = 8000; // clip each string field (stacks can be huge)
const MAX_FILE_BYTES = 5 * 1024 * 1024; // rotate past 5 MB (keep one .1 backup)

/** Path to the append-only client-error log (override root via CLAUDE_CONTROL_DIR). */
export function clientErrorsPath() {
  const base = process.env.CLAUDE_CONTROL_DIR || path.join(os.homedir(), '.claude-control');
  return path.join(base, 'logs', 'client-errors.jsonl');
}

function clip(v) {
  return typeof v === 'string' ? v.slice(0, MAX_FIELD) : '';
}

/**
 * Normalize + append one client-error record. Returns the stored record.
 * @param {object} body  parsed request JSON from the browser
 * @param {{ userAgent?: string, ts?: string }} [meta]  server-observed context
 */
export function recordClientError(body = {}, meta = {}) {
  const rec = {
    ts: meta.ts || new Date().toISOString(),
    source: clip(String(body.source || 'unknown')),
    message: clip(String(body.message || '')),
    stack: clip(String(body.stack || '')),
    componentStack: clip(String(body.componentStack || '')),
    sessionId: clip(String(body.sessionId || '')),
    label: clip(String(body.label || '')),
    url: clip(String(body.url || '')),
    userAgent: clip(String(body.userAgent || meta.userAgent || '')),
  };
  const p = clientErrorsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try {
    if (fs.statSync(p).size > MAX_FILE_BYTES) fs.renameSync(p, `${p}.1`);
  } catch {
    /* no file yet — nothing to rotate */
  }
  fs.appendFileSync(p, `${JSON.stringify(rec)}\n`);
  return rec;
}
