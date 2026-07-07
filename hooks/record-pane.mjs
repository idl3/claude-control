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
 *   → delete that file (only if it still belongs to THIS session — see below)
 *
 * No-op when not inside tmux ($TMUX_PANE unset). NEVER throws — a hook that
 * errors must not disrupt Claude, so everything is best-effort and exits 0.
 *
 * Headless-child guard: a nested/headless `claude -p` process spawned from
 * inside an interactive session INHERITS $TMUX_PANE from its parent shell.
 * Without a guard, such a child's SessionStart would overwrite the
 * interactive session's binding, and its SessionEnd would delete it. We
 * detect this by checking whether our parent process (the Claude process
 * that fired this hook) is attached to a real tty via `ps -o tty=`; a
 * headless child reports `??`/`?`/empty. On any lookup error we fail OPEN
 * (treat as tty-attached) so a `ps` hiccup never blocks legitimate recording.
 *
 * Matched delete: even with the tty guard, SessionEnd only deletes the pane
 * file when its recorded sessionId matches the ending session's id (or the
 * file is missing/malformed) — so a stray SessionEnd can never clobber a
 * different session's binding for the same pane.
 */
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const PANES_DIR = process.env.CC_PANES_DIR || path.join(homedir(), '.claude-control', 'panes');

/** %5 → "5"; tolerate any tmux pane-id form, keep it filename-safe. */
function paneFile(tmuxPane) {
  const safe = String(tmuxPane).replace(/[^A-Za-z0-9_-]/g, '');
  return safe ? path.join(PANES_DIR, `${safe}.json`) : null;
}

/**
 * True when this hook's parent (the Claude process that fired it) is
 * attached to a real tty. `CC_RECORD_PANE_TTY` lets tests simulate either
 * case without shelling out to `ps`; set it to `??`, `?`, or `` to simulate a
 * headless parent, or any other value to simulate a tty. Fails OPEN on any
 * `ps` error.
 */
function parentHasTty() {
  let tty;
  if (process.env.CC_RECORD_PANE_TTY !== undefined) {
    tty = process.env.CC_RECORD_PANE_TTY;
  } else {
    try {
      tty = execFileSync('ps', ['-o', 'tty=', '-p', String(process.ppid)], {
        encoding: 'utf8',
      }).trim();
    } catch {
      return true; // ps hiccup — fail open, behave as before.
    }
  }
  return tty !== '' && tty !== '??' && tty !== '?';
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

  // Headless nested child (e.g. `claude -p` inheriting $TMUX_PANE from its
  // interactive parent) — never touch the pane file for either event.
  if (!parentHasTty()) return;

  const input = await readStdin();
  const event = input.hook_event_name || '';

  if (event === 'SessionEnd') {
    const existing = await readFile(file, 'utf8')
      .then((raw) => JSON.parse(raw))
      .catch(() => null);
    // Delete only when the file is unreadable/malformed, or it still belongs
    // to THIS session — never remove a different session's live binding.
    if (existing === null || existing.sessionId === input.session_id) {
      await rm(file, { force: true }).catch(() => {});
    }
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
