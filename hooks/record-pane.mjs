#!/usr/bin/env node
/**
 * record-pane.mjs — Claude Code SessionStart/SessionEnd hook that records the
 * EXACT tmux-pane ↔ transcript mapping, so Claude Control never has to guess.
 *
 * Claude runs this inside its own process, which has `$TMUX_PANE` (the stable
 * tmux `%N` pane id) in its env and passes the session details on stdin. So
 * Claude itself authors the link — no title/time inference.
 *
 * SessionStart (startup | resume | clear | compact)
 *   → write ~/.claude-control/panes/<paneId>.json
 * SessionEnd
 *   → delete that file
 *
 * No-op when not inside tmux ($TMUX_PANE unset). NEVER throws — a hook that
 * errors must not disrupt Claude, so everything is best-effort and exits 0.
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const PANES_DIR = path.join(homedir(), '.claude-control', 'panes');

/** %5 → "5"; tolerate any tmux pane-id form, keep it filename-safe. */
function paneFile(tmuxPane) {
  const safe = String(tmuxPane).replace(/[^A-Za-z0-9_-]/g, '');
  return safe ? path.join(PANES_DIR, `${safe}.json`) : null;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function main() {
  const tmuxPane = process.env.TMUX_PANE;
  if (!tmuxPane) return; // not in tmux → nothing to map
  const file = paneFile(tmuxPane);
  if (!file) return;

  const input = await readStdin();
  const event = input.hook_event_name || '';

  if (event === 'SessionEnd') {
    await rm(file, { force: true }).catch(() => {});
    return;
  }

  // SessionStart (and any other start-ish event that carries a transcript).
  const transcriptPath = input.transcript_path || null;
  if (!transcriptPath) return;
  await mkdir(PANES_DIR, { recursive: true }).catch(() => {});
  const record = {
    paneId: tmuxPane,
    sessionId: input.session_id || null,
    transcriptPath,
    cwd: input.cwd || null,
    ts: Date.now(),
  };
  await writeFile(file, JSON.stringify(record), 'utf8').catch(() => {});
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
