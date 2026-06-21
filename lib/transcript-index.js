// lib/transcript-index.js — shared helpers for discovery-time transcript scanning.
//
// Extracted from lib/sessions.js into a neutral module so that both
// lib/sessions.js and lib/agents/claude.js can import it without creating a
// circular dependency (sessions.js → agents/index.js → claude.js → sessions.js).
//
// Resource doctrine: NEVER read a whole file. Only the tail (≤64 KB) of the
// newest *.jsonl per project directory is ever read.

import fs from 'node:fs/promises';
import path from 'node:path';

import { detectTranscriptPending } from './pending.js';

const TAIL_BYTES = 64 * 1024; // 64 KB max tail read

// ---------------------------------------------------------------------------
// readTail — read last maxBytes of a file without loading the whole thing
// ---------------------------------------------------------------------------

/**
 * Read the last `maxBytes` of a file and return its contents as a Buffer.
 * Never throws — returns null on any error.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<Buffer|null>}
 */
async function readTail(filePath, maxBytes) {
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
    const stat = await fh.stat();
    const size = stat.size;
    if (size === 0) return Buffer.alloc(0);
    const readSize = Math.min(size, maxBytes);
    const offset = size - readSize;
    const buf = Buffer.allocUnsafe(readSize);
    const { bytesRead } = await fh.read(buf, 0, readSize, offset);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// extractTailRecord — parse the tail of a JSONL file into a DiscoveredTranscript
// ---------------------------------------------------------------------------

/**
 * Parse the tail buffer of a JSONL file and return the last record that has a
 * truthy `.cwd` field, plus basic metadata.
 *
 * @param {string} filePath  Absolute path of the .jsonl file
 * @param {number} mtime     mtime (ms since epoch) of the file
 * @returns {Promise<import('./agents/adapter.js').DiscoveredTranscript|null>}
 */
export async function extractTailRecord(filePath, mtime) {
  const buf = await readTail(filePath, TAIL_BYTES);
  if (!buf) return null;

  const text = buf.toString('utf8');
  // Split on newlines; the first segment may be a partial line (the tail read
  // can start part-way through a line), so we never trust it — we only walk
  // complete lines from the end.
  const lines = text.split('\n');

  const base = {
    cwd: null,
    sessionId: null,
    lastActivity: null,
    model: null,
    aiTitle: null,
    customTitle: null,
    transcriptPath: filePath,
    mtime,
    transcriptPending: false,
    pendingToolUseId: null,
    pendingQuestion: null,
  };

  // Transcript-derived pending: detect an AskUserQuestion that is open in the
  // tail (no matching tool_result) even when no tailer is subscribed. Notifies
  // for ANY session, not just the one a client is watching.
  const pending = detectTranscriptPending(lines);
  base.transcriptPending = pending.transcriptPending;
  base.pendingToolUseId = pending.pendingToolUseId;
  base.pendingQuestion = pending.pendingQuestion;

  // Walk from end collecting the newest cwd/sessionId/timestamp/model/title.
  // ai-title is re-emitted throughout the file so the tail usually carries it;
  // custom-title (a user /rename) is written when renamed, so it appears late.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    if (base.lastActivity === null && typeof rec.timestamp === 'string') base.lastActivity = rec.timestamp;
    if (base.sessionId === null && typeof rec.sessionId === 'string') base.sessionId = rec.sessionId;
    if (base.customTitle === null && rec.type === 'custom-title' && rec.customTitle) base.customTitle = rec.customTitle;
    if (base.aiTitle === null && rec.type === 'ai-title' && rec.aiTitle) base.aiTitle = rec.aiTitle;
    if (base.model === null && rec.type === 'assistant' && typeof rec.message?.model === 'string') base.model = rec.message.model;
    if (base.cwd === null && typeof rec.cwd === 'string' && rec.cwd) base.cwd = rec.cwd;
    if (base.cwd && base.sessionId && base.model && (base.customTitle || base.aiTitle)) {
      break; // everything found
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// findNewestJsonl — returns { filePath, mtime } or null
// ---------------------------------------------------------------------------

/**
 * Given a directory, find the *.jsonl file with the newest mtime.
 *
 * @param {string} dir
 * @returns {Promise<{filePath:string, mtime:number}|null>}
 */
export async function findNewestJsonl(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  let newest = null;

  await Promise.all(
    entries
      .filter((e) => e.endsWith('.jsonl'))
      .map(async (e) => {
        const full = path.join(dir, e);
        let st;
        try { st = await fs.stat(full); } catch { return; }
        const mtime = st.mtimeMs;
        if (!newest || mtime > newest.mtime) {
          newest = { filePath: full, mtime };
        }
      }),
  );

  return newest;
}

// ---------------------------------------------------------------------------
// buildClaudeTranscriptIndex — the full index builder for Claude Code's
// projectsRoot, usable by both SessionRegistry and ClaudeAdapter.
// ---------------------------------------------------------------------------

/**
 * Scan all immediate subdirectories of projectsRoot. For each, find the newest
 * *.jsonl and extract the tail record. Returns {byDir, byCwd} indexed maps
 * (newest-mtime-wins per key).
 *
 * Each record is tagged with `agentType: 'claude'` for downstream session
 * object construction.
 *
 * @param {string} projectsRoot
 * @returns {Promise<import('./agents/adapter.js').TranscriptIndex>}
 */
export async function buildClaudeTranscriptIndex(projectsRoot) {
  /** @type {import('./agents/adapter.js').TranscriptIndex} */
  const index = { byDir: new Map(), byCwd: new Map() };

  let projectEntries;
  try {
    const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
    projectEntries = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, dir: path.join(projectsRoot, e.name) }));
  } catch {
    return index;
  }

  await Promise.all(
    projectEntries.map(async ({ name, dir }) => {
      const newest = await findNewestJsonl(dir);
      if (!newest) return;

      const rec = await extractTailRecord(newest.filePath, newest.mtime);
      if (!rec) return;

      // Tag the agent type so the registry can populate agentType on sessions.
      rec.agentType = 'claude';

      // Primary key: the project directory name (Claude Code's cwd encoding).
      const byDirExisting = index.byDir.get(name);
      if (!byDirExisting || newest.mtime > byDirExisting.mtime) {
        index.byDir.set(name, rec);
      }

      // Secondary key: the exact cwd recorded inside the transcript, when present.
      if (rec.cwd) {
        const byCwdExisting = index.byCwd.get(rec.cwd);
        if (!byCwdExisting || newest.mtime > byCwdExisting.mtime) {
          index.byCwd.set(rec.cwd, rec);
        }
      }
    }),
  );

  return index;
}
