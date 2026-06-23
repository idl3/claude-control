// lib/codex.js — Codex CLI support (flat named-export module).
//
// Handles transcript discovery from ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl,
// JSONL line parsing for the Codex event stream schema, TUI status extraction,
// and approval-modal detection/answering.
//
// This module must NOT import from lib/agents/index.js.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(_execFile);

// ---------------------------------------------------------------------------
// inputSummary — intentionally duplicated from lib/transcript.js (not exported
// there). Produces a short human-readable summary of a tool_use input object.
// Keep in sync with the canonical copy in lib/transcript.js:103-115.
// ---------------------------------------------------------------------------
function inputSummary(input) {
  if (input == null) return '';
  let s;
  try {
    s = JSON.stringify(input);
  } catch {
    s = String(input);
  }
  // Collapse newlines/tabs to spaces, then truncate.
  s = s.replace(/[\r\n\t]+/g, ' ');
  if (s.length > 120) s = s.slice(0, 117) + '...';
  return s;
}

// ---------------------------------------------------------------------------
// readHead — read the first maxBytes of a file without loading it all.
// Mirrors the readTail helper in lib/sessions.js but reads from offset 0.
// Never throws — returns null on any error.
// ---------------------------------------------------------------------------
async function readHead(filePath, maxBytes) {
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
    const stat = await fh.stat();
    const size = stat.size;
    if (size === 0) return Buffer.alloc(0);
    const readSize = Math.min(size, maxBytes);
    const buf = Buffer.allocUnsafe(readSize);
    const { bytesRead } = await fh.read(buf, 0, readSize, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// readTail — read the LAST maxBytes of a file without loading it all.
// Mirrors readHead but reads from offset max(0, size - maxBytes).
// Never throws — returns null on any error.
// ---------------------------------------------------------------------------
async function readTail(filePath, maxBytes) {
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
    const stat = await fh.stat();
    const size = stat.size;
    if (size === 0) return Buffer.alloc(0);
    const readSize = Math.min(size, maxBytes);
    const offset = Math.max(0, size - maxBytes);
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
// extractUsageFromTail — given a text blob, scan lines from the END and
// return the newest token_count event_msg's primary rate-limit data.
//
// Returns { usagePct, usageWindowMin } where usagePct is the primary
// used_percent (number) and usageWindowMin is the primary window_minutes
// (number). Returns null if no valid token_count line is found.
// ---------------------------------------------------------------------------
export function extractUsageFromTail(text) {
  if (!text) return null;
  const lines = text.split('\n');
  // Iterate from the end — newest first.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== 'event_msg') continue;
    if (rec.payload?.type !== 'token_count') continue;
    const primary = rec.payload?.rate_limits?.primary;
    if (primary == null) continue;
    const usagePct = primary.used_percent;
    const usageWindowMin = primary.window_minutes;
    if (typeof usagePct !== 'number' || typeof usageWindowMin !== 'number') continue;
    return { usagePct, usageWindowMin };
  }
  return null;
}

// ---------------------------------------------------------------------------
// matchesProcess
//
// A pane is a Codex session when its process title is exactly "codex",
// a path ending in "/codex", or "codex" followed by a space (with flags).
// Does NOT match "codex-control" or version strings like "2.1.162".
// ---------------------------------------------------------------------------
export function processMatchKind(cmd) {
  const c = String(cmd || '').trim();
  if (!c) return null;
  const parts = c.split(/\s+/).filter(Boolean);
  const basename = (s) => String(s || '').replace(/\\/g, '/').split('/').pop();
  if (basename(parts[0]) === 'codex') return 'direct';
  if (basename(parts[0]) === 'node' && basename(parts[1]) === 'codex') return 'node-wrapper';
  return null;
}

export function matchesProcess(cmd) {
  return processMatchKind(cmd) !== null;
}

// ---------------------------------------------------------------------------
// parseCodexRecord
//
// Parse one JSONL line from a Codex rollout file into a NormalizedMessage,
// or null when the line is not a displayable message record.
//
// CRITICAL de-dup: `event_msg/*` records duplicate content already in
// `response_item/*` — return null for all event_msg types to prevent
// double-render. Also null for turn_context, session_meta, and unknown types.
// ---------------------------------------------------------------------------
export function parseCodexRecord(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let record;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const t = record.type;
  const p = record.payload || {};
  const ts = record.timestamp ?? null;

  // All event_msg, turn_context, and session_meta records are null.
  if (t !== 'response_item') return null;

  const subType = p.type;

  // --- response_item/message ---
  if (subType === 'message') {
    const rawRole = p.role;
    // developer = system/permissions injection; null it.
    if (rawRole === 'developer') return null;
    let role;
    if (rawRole === 'assistant') role = 'assistant';
    else if (rawRole === 'user') role = 'user';
    else return null;

    const blocks = [];
    if (Array.isArray(p.content)) {
      for (const item of p.content) {
        const text = item?.text;
        if (typeof text === 'string' && text) {
          blocks.push({ kind: 'text', text });
        }
      }
    }
    if (blocks.length === 0) return null;

    return {
      uuid: record.id ?? p.id ?? null,
      role,
      ts,
      blocks,
      rawType: 'message',
    };
  }

  // --- response_item/reasoning (encrypted) ---
  if (subType === 'reasoning') {
    return {
      uuid: record.id ?? null,
      role: 'assistant',
      ts,
      blocks: [{ kind: 'thinking', text: '[reasoning encrypted]' }],
      rawType: 'reasoning',
    };
  }

  // --- response_item/function_call (exec_command, etc.) ---
  if (subType === 'function_call') {
    let parsedArgs;
    try {
      parsedArgs = JSON.parse(p.arguments);
    } catch {
      parsedArgs = { raw: p.arguments };
    }
    return {
      uuid: p.call_id ?? null,
      role: 'assistant',
      ts,
      blocks: [
        {
          kind: 'tool_use',
          id: p.call_id,
          name: p.name || 'exec_command',
          input: parsedArgs,
          inputSummary: inputSummary(parsedArgs),
        },
      ],
      rawType: 'function_call',
    };
  }

  // --- response_item/function_call_output ---
  if (subType === 'function_call_output') {
    return {
      uuid: p.call_id != null ? p.call_id + '-out' : null,
      role: 'user',
      ts,
      blocks: [
        {
          kind: 'tool_result',
          forId: p.call_id,
          text: String(p.output ?? ''),
          isError: false,
        },
      ],
      rawType: 'function_call_output',
    };
  }

  // --- response_item/custom_tool_call (apply_patch) ---
  if (subType === 'custom_tool_call') {
    // p.input is the raw patch text string.
    const patchInput = { patch: p.input, status: p.status };
    return {
      uuid: p.call_id ?? null,
      role: 'assistant',
      ts,
      blocks: [
        {
          kind: 'tool_use',
          id: p.call_id,
          name: p.name || 'apply_patch',
          input: patchInput,
          inputSummary: inputSummary(patchInput),
        },
      ],
      rawType: 'custom_tool_call',
    };
  }

  // --- response_item/custom_tool_call_output ---
  if (subType === 'custom_tool_call_output') {
    return {
      uuid: p.call_id != null ? p.call_id + '-out' : null,
      role: 'user',
      ts,
      blocks: [
        {
          kind: 'tool_result',
          forId: p.call_id,
          text: String(p.output ?? ''),
          isError: false,
        },
      ],
      rawType: 'custom_tool_call_output',
    };
  }

  // All other response_item subtypes → null.
  return null;
}

export async function readCodexTranscriptRecord(filePath) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  const mtime = stat.mtimeMs;

  // Head-read only the first 65536 bytes to extract session_meta.
  const buf = await readHead(filePath, 65536);
  if (!buf || buf.length === 0) return null;

  const text = buf.toString('utf8');
  const firstLine = text.split('\n')[0];
  if (!firstLine || !firstLine.trim()) return null;

  let record;
  try {
    record = JSON.parse(firstLine.trim());
  } catch {
    return null;
  }

  if (record.type !== 'session_meta') return null;
  const payload = record.payload || {};
  if (typeof payload.cwd !== 'string' || !payload.cwd) return null;

  const lastActivity = record.timestamp ?? null;
  const lastActivityMs = lastActivity ? (Date.parse(lastActivity) || null) : null;

  // Tail-read for rate-limit usage (token_count events appear throughout).
  let usagePct = null;
  let usageWindowMin = null;
  const tailBuf = await readTail(filePath, 32768);
  if (tailBuf && tailBuf.length > 0) {
    const tailText = tailBuf.toString('utf8');
    const usage = extractUsageFromTail(tailText);
    if (usage) {
      usagePct = usage.usagePct;
      usageWindowMin = usage.usageWindowMin;
    }
  }

  return {
    cwd: payload.cwd,
    sessionId: payload.id ?? null,
    lastActivity,
    lastActivityMs,
    // session_meta has model_provider but no concrete model id.
    model: null,
    aiTitle: null,
    customTitle: null,
    transcriptPath: filePath,
    mtime,
    transcriptPending: false,
    pendingToolUseId: null,
    pendingQuestion: null,
    agentType: 'codex',
    usagePct,
    usageWindowMin,
  };
}

// ---------------------------------------------------------------------------
// readRolloutMeta
//
// Read a single rollout .jsonl file and return the discovered record object,
// or null on any failure (missing file, empty, non-session_meta first line,
// missing cwd).
//
// This is the per-file parsing logic extracted from buildTranscriptIndex so
// it can be called directly by findOpenRollout-based binding (lsof path).
// Unlike the loop inside buildTranscriptIndex, this function does NOT apply
// the ACTIVE_WINDOW mtime gate — a live file found via lsof must always be
// parsed regardless of mtime staleness.
// ---------------------------------------------------------------------------
export async function readRolloutMeta(filePath, now = new Date()) {
  try {
    const stat = await fs.stat(filePath);
    const mtime = stat.mtimeMs;

    const buf = await readHead(filePath, 65536);
    if (!buf || buf.length === 0) return null;

    const text = buf.toString('utf8');
    const firstLine = text.split('\n')[0];
    if (!firstLine || !firstLine.trim()) return null;

    let record;
    try {
      record = JSON.parse(firstLine.trim());
    } catch {
      return null;
    }

    if (record.type !== 'session_meta') return null;
    const payload = record.payload || {};
    if (typeof payload.cwd !== 'string' || !payload.cwd) return null;

    const lastActivity = record.timestamp ?? null;
    const lastActivityMs = lastActivity ? (Date.parse(lastActivity) || null) : null;

    let usagePct = null;
    let usageWindowMin = null;
    const tailBuf = await readTail(filePath, 32768);
    if (tailBuf && tailBuf.length > 0) {
      const tailText = tailBuf.toString('utf8');
      const usage = extractUsageFromTail(tailText);
      if (usage) {
        usagePct = usage.usagePct;
        usageWindowMin = usage.usageWindowMin;
      }
    }

    return {
      cwd: payload.cwd,
      sessionId: payload.id ?? null,
      lastActivity,
      lastActivityMs,
      model: null,
      aiTitle: null,
      customTitle: null,
      transcriptPath: filePath,
      mtime,
      transcriptPending: false,
      pendingToolUseId: null,
      pendingQuestion: null,
      agentType: 'codex',
      usagePct,
      usageWindowMin,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// parseLsofRollout
//
// Pure parser for `lsof -Fn` stdout output. Returns the first open file path
// that matches a Codex rollout pattern (/rollout-*.jsonl), or null if none.
//
// lsof -Fn output format:
//   p<pid>
//   f<fd>
//   n<path>
//   ...
//
// We look only at lines starting with 'n' whose remainder ends with
// /rollout-<something>.jsonl.
// ---------------------------------------------------------------------------
export function parseLsofRollout(stdout) {
  if (!stdout) return null;
  const lines = stdout.split('\n');
  for (const line of lines) {
    if (!line.startsWith('n')) continue;
    const filePath = line.slice(1);
    if (/\/rollout-[^/]*\.jsonl$/.test(filePath)) return filePath;
  }
  return null;
}

// ---------------------------------------------------------------------------
// findOpenRollout
//
// Given a codex process pid, run `lsof -p <pid> -Fn` and return the path of
// the rollout .jsonl file the process has open, or null if not found / any
// error / pid is null/invalid.
//
// Best-effort: any lsof failure (timeout, non-zero exit, ENOENT, etc.)
// returns null and never throws — the caller falls back to the heuristic.
// ---------------------------------------------------------------------------
export async function findOpenRollout(pid) {
  if (pid == null || typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return null;
  try {
    const { stdout } = await execFile(
      '/usr/sbin/lsof',
      ['-p', String(pid), '-Fn'],
      { timeout: 2000 },
    );
    return parseLsofRollout(stdout);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// buildTranscriptIndex
//
// Scan recent Codex session date directories for rollout-*.jsonl files.
// Checks today and yesterday (by local date) to handle sessions that
// started near midnight.
//
// The `now` parameter is injected for testability — callers that do not
// care about the clock may omit it and get `new Date()`.
// ---------------------------------------------------------------------------
export async function buildTranscriptIndex({ codexSessionsRoot }, now = new Date()) {
  const index = { byCwd: new Map(), byPath: new Map(), bySessionId: new Map() };

  if (!codexSessionsRoot) return index;

  // Compute the date dir path for a given Date using LOCAL date parts
  // (Codex CLI uses local wall-clock date for its session directory names).
  function datePath(d) {
    const yyyy = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return path.join(codexSessionsRoot, yyyy, mm, dd);
  }

  // Codex appends to ONE rollout file per session, stored under its START-date
  // dir — so a long-running session's file stays in an old date dir while its
  // mtime keeps advancing. Scanning only today+yesterday therefore loses any
  // session that started >1 day ago but is still active (it vanishes from the
  // UI). Scan the last LOOKBACK_DAYS date dirs (cheap readdir + stat), but only
  // parse rollouts whose mtime is recent (ACTIVE_WINDOW) so we never head/tail-
  // read the thousands of dead rollouts that accumulate over time.
  // ponytail: 14-day start-age ceiling — a codex session running continuously
  // for >14 days would need a wider window; widen LOOKBACK_DAYS if that happens.
  const LOOKBACK_DAYS = 14;
  const ACTIVE_WINDOW_MS = 3 * 24 * 3600 * 1000;
  const dateDirs = [];
  const seenDirs = new Set();
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const dp = datePath(new Date(now.getTime() - i * 24 * 3600 * 1000));
    if (!seenDirs.has(dp)) {
      seenDirs.add(dp);
      dateDirs.push(dp);
    }
  }

  for (const dateDir of dateDirs) {
    let files;
    try {
      files = await fs.readdir(dateDir);
    } catch {
      // Missing dir is normal — skip silently.
      continue;
    }

    const rollouts = files.filter((f) => /^rollout-.*\.jsonl$/.test(f));

    await Promise.all(
      rollouts.map(async (filename) => {
        const filePath = path.join(dateDir, filename);
        try {
          // Stat for mtime gate (active window check).
          const stat = await fs.stat(filePath);
          const mtime = stat.mtimeMs;

          // Skip dead sessions: only parse rollouts touched within ACTIVE_WINDOW.
          // This keeps the expensive head/tail reads bounded to live sessions even
          // though we now scan many more date dirs. (now - mtime can be negative
          // under an injected test clock — treated as active, never skipped.)
          if (now.getTime() - mtime > ACTIVE_WINDOW_MS) return;

          const discovered = await readCodexTranscriptRecord(filePath);
          if (!discovered) return;

          // Newest mtime wins per cwd.
          const existing = index.byCwd.get(discovered.cwd);
          if (!existing || discovered.mtime > existing.mtime) {
            index.byCwd.set(discovered.cwd, discovered);
          }
          index.byPath.set(discovered.transcriptPath, discovered);
          if (discovered.sessionId) {
            const byId = index.bySessionId.get(discovered.sessionId);
            if (!byId || discovered.mtime > byId.mtime) {
              index.bySessionId.set(discovered.sessionId, discovered);
            }
          }
        } catch {
          // Per-file resilience: skip malformed or unreadable files.
        }
      }),
    );
  }

  return index;
}

// ---------------------------------------------------------------------------
// detectPendingFromCapture
//
// Detect a Codex approval modal from a capture-pane dump.
// (P2 deferred wiring — implemented and tested here, not yet called by
// shared code. detectPendingFromCapture is the Codex-only pending channel.)
//
// Returns a shape describing the modal kind, header text, and available
// options.
//
// Headings recognized:
//   "Would you like to run the following command?" → 'exec_command'
//   "Would you like to make the following edits?"  → 'apply_patch'
//   "Do you trust the contents of this directory?" → 'directory_trust'
// ---------------------------------------------------------------------------
export function detectPendingFromCapture(capture) {
  const noModal = { transcriptPending: false, pendingKind: null, header: null, options: [] };
  if (!capture) return noModal;

  const lines = capture.split('\n');

  // Build a whitespace-free concatenation of all lines for wrap-tolerant heading
  // matching. A narrow pane may break mid-word (e.g. "follo" + "wing"), so joining
  // with a space would produce "follo wing" — not matching "following". Instead we
  // strip all whitespace from both the candidate and the heading before comparing.
  const dewrapped = lines.join('').replace(/\s+/g, '');

  const headings = [
    { text: 'Would you like to run the following command?', kind: 'exec_command' },
    { text: 'Would you like to make the following edits?', kind: 'apply_patch' },
    { text: 'Do you trust the contents of this directory?', kind: 'directory_trust' },
  ];

  let pendingKind = null;
  let header = null;
  let headingIdx = -1;

  // First try per-line exact match (fast path, no allocation).
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    for (const h of headings) {
      if (trimmed === h.text) {
        pendingKind = h.kind;
        header = h.text;
        headingIdx = i;
        break;
      }
    }
    if (headingIdx !== -1) break;
  }

  // If exact per-line match failed, try wrap-tolerant match by comparing
  // whitespace-stripped strings. A narrow pane can break mid-word (e.g.
  // "follo" + "wing"), so we strip all whitespace from both the candidate
  // and the heading before comparing, then use the canonical heading text.
  if (!pendingKind) {
    for (const h of headings) {
      const headingStripped = h.text.replace(/\s+/g, '');
      if (dewrapped.includes(headingStripped)) {
        pendingKind = h.kind;
        header = h.text;
        // Locate the line that starts the heading by finding the first line
        // that contains the opening word(s). The heading start line is the
        // anchor from which we begin option scanning (after the heading block).
        const firstWord = h.text.split(' ')[0];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(firstWord)) {
            headingIdx = i;
            break;
          }
        }
        break;
      }
    }
  }

  // Option line regex: /^\s*[›\s]\s*(\d+)\.\s+(.+?)(?:\s+\(([^)]+)\))?\s*$/
  // U+203A = ›
  const optionLineRegex = /^\s*[›\s]\s*(\d+)\.\s+(.+?)(?:\s+\(([^)]+)\))?\s*$/;

  // Footer detection — prefix-based so wrapped footers still stop collection.
  const isFooterLine = (line) => {
    const t = line.trim();
    return (
      t.startsWith('Press enter to confirm or esc to') ||
      t.startsWith('Press enter to continue')
    );
  };

  const options = [];
  let seenOption = false;

  if (pendingKind && headingIdx !== -1) {
    for (let i = headingIdx + 1; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();

      // Check footer hint — stop collecting after it.
      if (isFooterLine(raw)) break;

      const m = optionLineRegex.exec(raw);
      if (m) {
        seenOption = true;
        options.push({
          n: Number(m[1]),
          label: m[2].trim(),
          shortcut: m[3] || null,
          // Highlighted if the raw line contains the › character (U+203A).
          highlighted: raw.includes('›'),
        });
      } else if (seenOption && trimmed && !m) {
        // First non-blank, non-option line after at least one option was captured.
        break;
      }
    }
  }

  if (options.length === 0 && pendingKind) return noModal;

  // ── Generic fallback: planning / clarifying question ───────────────────────
  // No known heading matched. Check whether the capture contains a numbered
  // picker (Codex uses › 1. / 2. lines) AND a confirm/cancel footer. If so,
  // treat it as a free-form question with pendingKind='question'.
  if (!pendingKind) {
    // Scan for footer first — a footer is required.
    const hasFooter = lines.some(isFooterLine);
    if (hasFooter) {
      // Collect options and find the index of the first option line.
      let firstOptionIdx = -1;
      const genericOptions = [];
      let genericSeenOption = false;
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isFooterLine(raw)) break;
        const m = optionLineRegex.exec(raw);
        if (m) {
          if (firstOptionIdx === -1) firstOptionIdx = i;
          genericSeenOption = true;
          genericOptions.push({
            n: Number(m[1]),
            label: m[2].trim(),
            shortcut: m[3] || null,
            highlighted: raw.includes('›'),
          });
        } else if (genericSeenOption && raw.trim() && !m) {
          break;
        }
      }

      if (genericOptions.length > 0) {
        // Derive header from the question block immediately above the options.
        // Codex separates the question from the picker with a blank line, so we
        // first skip any blanks directly above the first option, then collect the
        // contiguous block of non-empty lines — stopping at the next blank. This
        // captures the actual question without sweeping in preceding scrollback.
        let i = firstOptionIdx - 1;
        while (i >= 0 && !lines[i].trim()) i--; // skip the separator blank(s)
        const questionLines = [];
        for (; i >= 0; i--) {
          const t = lines[i].trim();
          if (!t) break;
          questionLines.unshift(t);
        }
        const derivedHeader = questionLines.join(' ').replace(/\s+/g, ' ').trim() || 'Question';

        return {
          transcriptPending: true,
          pendingKind: 'question',
          header: derivedHeader,
          options: genericOptions,
        };
      }
    }
    return noModal;
  }

  if (options.length === 0) return noModal;

  return { transcriptPending: true, pendingKind, header, options };
}

// ---------------------------------------------------------------------------
// buildAnswerProgram
//
// Build the keystroke token array that answers the current Codex approval
// modal. Output is compatible with lib/answer.js tmux send-keys token format.
//
// Selections: first element of the first selection is a digit string or
// option label. Falls back to the highlighted option, then option 1.
// ---------------------------------------------------------------------------
export function buildAnswerProgram(pending, selections) {
  const opts = pending?.options || [];
  const sel = selections?.[0]?.[0];
  let digit = null;
  if (sel != null) {
    if (/^\d+$/.test(String(sel))) digit = String(sel);
    else {
      const m = opts.find((o) => o.label === sel);
      if (m) digit = String(m.n);
    }
  }
  if (digit == null) {
    const hl = opts.find((o) => o.highlighted);
    digit = hl ? String(hl.n) : '1';
  }
  return [digit, 'Enter'];
}

// ---------------------------------------------------------------------------
// codexPendingToFrontend
//
// Map detectPendingFromCapture's output to the PanePrompt shape that
// parsePanePrompt returns, so the existing prompt-frame UI can render it
// with zero frontend type/component changes.
//
// Returns null when there is no active modal or no options.
// ---------------------------------------------------------------------------
export function codexPendingToFrontend(pending) {
  if (!pending || !pending.transcriptPending || !pending.options || pending.options.length === 0) {
    return null;
  }
  return {
    question: pending.header,
    options: pending.options.map((o) => ({
      key: String(o.n),
      label: o.label,
      selected: !!o.highlighted,
    })),
    // Do NOT set multiSelect — Codex approvals are single-select radio.
  };
}

// ---------------------------------------------------------------------------
// parseCodexPrompt
//
// Thin combinator: detect + map in one call. Used by startPromptPoller.
// ---------------------------------------------------------------------------
export function parseCodexPrompt(capture) {
  return codexPendingToFrontend(detectPendingFromCapture(capture));
}

// ---------------------------------------------------------------------------
// buildSpawnCommand
//
// Build the spawn command for a new Codex session.
// Codex requires -C <cwd> to set the working directory (tmux -c alone is
// insufficient because Codex reads cwd from its own flag, not the shell env).
// ---------------------------------------------------------------------------
export function buildSpawnCommand({ cwd, bin = 'codex' } = {}) {
  return { bin, args: ['-C', cwd] };
}

/**
 * Build the command shape for Codex app-server mode. `bin` is the configured
 * operator command (for example "codex" or "yodex"); callers append and quote
 * runtime args before typing the command into the tmux shell.
 */
export function buildAppServerCommand({ endpoint, bin = 'codex' } = {}) {
  return { bin, args: ['app-server', '--listen', endpoint] };
}

// ---------------------------------------------------------------------------
// parseTuiStatus
//
// Parse model name from a Codex TUI header capture.
// The header contains: │ model:     gpt-5.5 xhigh   fast   /model to change │
// Captures model + effort token (e.g. "gpt-5.5 xhigh") so the rail shows
// both the model name and the reasoning effort setting.
// ctx% is not shown in the Codex TUI.
// ---------------------------------------------------------------------------
export function parseTuiStatus(capture) {
  const text = capture || '';
  // Match model name + optional effort token (e.g. "gpt-5.5 xhigh").
  // The header line looks like: "model:     gpt-5.5 xhigh   fast   /model to change"
  // We capture the first token (model) and an optional second token (effort),
  // stopping before known non-effort tokens: "fast", "slow", "/model".
  const EFFORT_TOKENS = new Set(['xhigh', 'high', 'medium', 'low']);
  let model = null;
  // (1) Top header box (visible at session start, before output scrolls it off):
  //     "model:     gpt-5.5 xhigh   fast   /model to change"
  const header = /model:\s+(\S+)(?:\s+(\S+))?/.exec(text);
  if (header) {
    model = EFFORT_TOKENS.has((header[2] || '').toLowerCase())
      ? `${header[1]} ${header[2]}`
      : header[1];
  }
  // (2) Persistent footer status line (always at the bottom, which is what the
  //     8-line ctx-poll capture actually sees): "gpt-5.5 xhigh Fast · <cwd>".
  //     Capture model + optional effort, then the speed word, then the " · " cwd
  //     separator. Used only when the header isn't in view.
  if (!model) {
    const footer = /^\s*([\w.\-]+)(?:\s+(xhigh|high|medium|low))?\s+\S+\s+·\s/m.exec(text);
    if (footer) model = footer[2] ? `${footer[1]} ${footer[2]}` : footer[1];
  }
  // Codex prints "• Working (<N>s • esc to interrupt)" while generating.
  const working = /esc to interrupt/.test(text) || /Working \(/.test(text);
  return { ctxPct: null, model, working };
}

// ---------------------------------------------------------------------------
// prettyModel
//
// Codex model ids are already human-readable (e.g. "gpt-5.5").
// ---------------------------------------------------------------------------
export function prettyModel(modelId) {
  return modelId || null;
}
