/**
 * lib/shell.js — a single server-owned tmux "sister" pane for the composer's
 * terminal mode (>_). Runs shell command lines, sends an allow-listed set of
 * control keys, and exposes pane capture for the live terminal view. It's a real
 * PTY (tmux), so interactive flows (npm login, prompts, OTP) work.
 *
 * Security: same posture as the rest of the app — WS traffic is token-gated and
 * bound to 127.0.0.1 / the tailnet; this is no broader than the existing ttyd
 * escape hatch. Commands run as the server user, in a dedicated window.
 */
import * as tmux from './tmux.js';
import { readConfig } from './config.js';

const SHELL_WINDOW = 'cc-shell';

// Control keys the UI may send (mirrors the `promptkey` allow-list philosophy —
// the command body goes through send-keys -l as literal text; only these named
// keys are interpreted). No arbitrary key-name injection.
export const SHELL_KEYS = new Set(['Enter', 'C-c', 'C-d', 'Up', 'Down', 'Tab', 'Escape']);

let shellTarget = null;

/** Find the live cc-shell pane target, or null. */
async function findShellTarget() {
  try {
    const panes = await tmux.listPanes();
    const p = panes.find((x) => x.windowName === SHELL_WINDOW);
    return p ? p.target : null;
  } catch {
    return null;
  }
}

/**
 * Ensure a dedicated shell pane exists; returns its tmux target. Reuses an
 * existing `cc-shell` window (so it survives reconnects / server restarts) or
 * creates one rooted at `cwd` (falls back to the configured defaultCwd).
 *
 * @param {string} [cwd]
 * @returns {Promise<string>}
 */
export async function ensureShellPane(cwd) {
  const existing = await findShellTarget();
  if (existing && tmux.isValidTarget(existing)) {
    shellTarget = existing;
    return shellTarget;
  }
  const dir = typeof cwd === 'string' && cwd ? cwd : readConfig().defaultCwd;
  const target = await tmux.createWindow({ cwd: dir, name: SHELL_WINDOW });
  if (!tmux.isValidTarget(target)) throw new Error('shell: invalid pane target');
  shellTarget = target;
  return shellTarget;
}

/** Run a command line (literal text + Enter) in the shell pane. */
export async function shellInput(line, cwd) {
  const target = await ensureShellPane(cwd);
  await tmux.sendText(target, String(line ?? ''));
}

/** Send one allow-listed control key (e.g. C-c). Throws on anything else. */
export async function shellKey(key, cwd) {
  if (!SHELL_KEYS.has(key)) throw new Error('key not allowed');
  const target = await ensureShellPane(cwd);
  await tmux.sendRawKeys(target, [key]);
}

/** Capture the shell pane (plain text) for the live view. */
export async function shellCapture(lines = 200, cwd) {
  const target = await ensureShellPane(cwd);
  const n = Math.max(1, Math.min(10000, Number(lines) || 200));
  return tmux.capturePane(target, n);
}
