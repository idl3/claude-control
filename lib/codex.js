// lib/codex.js — Codex CLI support (flat named-export module).
//
// Handles transcript discovery from ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl,
// JSONL line parsing for the Codex event stream schema, TUI status extraction,
// and approval-modal detection/answering.
//
// This module must NOT import from lib/agents/index.js.

import fs from 'node:fs/promises';
import path from 'node:path';

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
// matchesProcess
//
// A pane is a Codex session when its process title is exactly "codex",
// a path ending in "/codex", or "codex" followed by a space (with flags).
// Does NOT match "codex-control" or version strings like "2.1.162".
// ---------------------------------------------------------------------------
export function matchesProcess(cmd) {
  const c = String(cmd || '').trim();
  return c === 'codex' || /(^|\/)codex$/.test(c) || /^codex\s/.test(c);
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
  const index = { byCwd: new Map() };

  if (!codexSessionsRoot) return index;

  // Compute the date dir path for a given Date using LOCAL date parts
  // (Codex CLI uses local wall-clock date for its session directory names).
  function datePath(d) {
    const yyyy = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return path.join(codexSessionsRoot, yyyy, mm, dd);
  }

  const today = datePath(now);
  const yesterday = datePath(new Date(now.getTime() - 24 * 3600 * 1000));
  // Dedup if equal (e.g. right at midnight boundary)
  const dateDirs = today === yesterday ? [today] : [today, yesterday];

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
          // Stat for mtime.
          const stat = await fs.stat(filePath);
          const mtime = stat.mtimeMs;

          // Head-read only the first 65536 bytes to extract session_meta.
          const buf = await readHead(filePath, 65536);
          if (!buf || buf.length === 0) return;

          const text = buf.toString('utf8');
          const firstLine = text.split('\n')[0];
          if (!firstLine || !firstLine.trim()) return;

          let record;
          try {
            record = JSON.parse(firstLine.trim());
          } catch {
            return;
          }

          if (record.type !== 'session_meta') return;
          const payload = record.payload || {};
          if (typeof payload.cwd !== 'string' || !payload.cwd) return;

          const lastActivity = record.timestamp ?? null;
          const lastActivityMs = lastActivity ? (Date.parse(lastActivity) || null) : null;
          const discovered = {
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
          };

          // Newest mtime wins per cwd.
          const existing = index.byCwd.get(payload.cwd);
          if (!existing || mtime > existing.mtime) {
            index.byCwd.set(payload.cwd, discovered);
          }
        } catch {
          // Per-file resilience: skip malformed or unreadable files.
        }
      }),
    );
  }

  // Return byCwd only — no byDir key. sessions.js merge loop guards `if (byDir)`.
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

  const headings = [
    { text: 'Would you like to run the following command?', kind: 'exec_command' },
    { text: 'Would you like to make the following edits?', kind: 'apply_patch' },
    { text: 'Do you trust the contents of this directory?', kind: 'directory_trust' },
  ];

  let pendingKind = null;
  let header = null;
  let headingIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    for (const h of headings) {
      if (trimmed === h.text) {
        pendingKind = h.kind;
        header = trimmed;
        headingIdx = i;
        break;
      }
    }
    if (headingIdx !== -1) break;
  }

  if (!pendingKind) return noModal;

  // Scan lines after the heading for option lines.
  // Option line regex: /^\s*[›\s]\s*(\d+)\.\s+(.+?)(?:\s+\(([^)]+)\))?\s*$/
  // U+203A = ›
  const optionLineRegex = /^\s*[›\s]\s*(\d+)\.\s+(.+?)(?:\s+\(([^)]+)\))?\s*$/;
  const footerHints = ['Press enter to confirm or esc to cancel', 'Press enter to continue'];

  const options = [];
  let seenOption = false;

  for (let i = headingIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Check footer hint — stop collecting after it.
    if (footerHints.includes(trimmed)) break;

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

// ---------------------------------------------------------------------------
// parseTuiStatus
//
// Parse model name from a Codex TUI header capture.
// The header contains: │ model:     gpt-5.5 xhigh   fast   /model to change │
// Extracts the model identifier immediately after "model:" with optional whitespace.
// ctx% is not shown in the Codex TUI.
// ---------------------------------------------------------------------------
export function parseTuiStatus(capture) {
  const text = capture || '';
  const m = /model:\s+(\S+)/.exec(text);
  // Codex prints "• Working (<N>s • esc to interrupt)" while generating.
  const working = /esc to interrupt/.test(text) || /Working \(/.test(text);
  return { ctxPct: null, model: m ? m[1] : null, working };
}

// ---------------------------------------------------------------------------
// prettyModel
//
// Codex model ids are already human-readable (e.g. "gpt-5.5").
// ---------------------------------------------------------------------------
export function prettyModel(modelId) {
  return modelId || null;
}
