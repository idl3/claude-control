/**
 * lib/shell.js — per-session "sister" shell panes for the composer's terminal
 * mode (>_). Each Claude session gets its OWN scratch shell, created on demand
 * as a pane in that session's window (so it shares the window and inherits the
 * cwd), and reused thereafter. Marked with the pane option `@cc_shell` so it can
 * be found again. It's a real PTY (tmux), so interactive flows (npm login,
 * prompts, OTP) work.
 *
 * Security: same posture as the rest of the app — WS traffic is token-gated and
 * bound to 127.0.0.1 / the tailnet; this is no broader than the existing ttyd
 * escape hatch. Commands run as the server user.
 */
import * as tmux from './tmux.js';
import { readConfig } from './config.js';

/** "0:1.2" → "0:1" (drop the pane index to address the window). */
function windowOf(target) {
  return String(target || '').replace(/\.\d+$/, '');
}

// Control keys the UI may send (mirrors the `promptkey` allow-list philosophy —
// the command body goes through send-keys -l as literal text; only these named
// keys are interpreted). The set is generated but still a closed allow-list:
// every value is a known tmux send-keys token, so no arbitrary key-name injection.
// Covers the on-screen key bar (arrows / Tab / Esc / Ctrl-* / Home / End / paging)
// so a phone keyboard can reach keys it can't physically produce.
const ALPHA = 'abcdefghijklmnopqrstuvwxyz'.split('');
const NAMED_KEYS = [
  'Enter', 'Tab', 'BTab', 'Escape', 'BSpace', 'DC', 'IC', 'Space',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PPage', 'NPage',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
];
// Navigation keys with every Ctrl/Meta/Shift modifier combination, so a hardware
// keyboard (e.g. iPad Magic Keyboard) can send Opt+Arrow word-jumps, Shift+Arrow
// selection, etc. Prefix order is C-,M-,S- (matches the frontend navToken).
const NAV_KEYS = ['Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PPage', 'NPage'];
const NAV_PREFIXES = ['', 'C-', 'M-', 'S-', 'C-M-', 'C-S-', 'M-S-', 'C-M-S-'];
const NAV_COMBOS = NAV_KEYS.flatMap((k) => NAV_PREFIXES.map((p) => p + k));

export const SHELL_KEYS = new Set([
  ...NAMED_KEYS,
  ...NAV_COMBOS, // Up/Down/.../NPage with C-/M-/S- combinations
  ...ALPHA.map((c) => `C-${c}`), // C-a .. C-z
  ...ALPHA.map((c) => `M-${c}`), // M-a .. M-z (Option/Meta)
]);

/**
 * Ensure the sister shell pane for a session's WINDOW exists; return its target.
 * Reuses the `@cc_shell`-marked pane in that window, or splits the window to make
 * one (rooted at the session's cwd, `-d` so the Claude pane keeps focus). Falls
 * back to creating a standalone window only if there's no window to split.
 *
 * @param {string} sessionTarget  e.g. "0:1.1" (the Claude pane)
 * @param {string} [cwd]
 * @returns {Promise<string>} sister shell pane target
 */
export async function ensureSessionShell(sessionTarget, cwd) {
  const win = windowOf(sessionTarget);
  const dir = typeof cwd === 'string' && cwd ? cwd : readConfig().defaultCwd;

  // Reuse an existing marked sister pane in this window.
  try {
    const panes = await tmux.listPanes();
    const sister = panes.find(
      (p) => p.ccShell && windowOf(p.target) === win && tmux.isValidTarget(p.target),
    );
    if (sister) return sister.target;
  } catch {
    // fall through to create
  }

  // Split the session's window to add the sister shell (no focus steal).
  let target;
  if (win && tmux.isValidTarget(`${win}.0`)) {
    target = await tmux.splitWindow({ windowTarget: win, cwd: dir });
  } else {
    // No resolvable window (e.g. session vanished) — create a standalone one.
    target = await tmux.createWindow({ cwd: dir, name: 'cc-shell' });
  }
  if (!tmux.isValidTarget(target)) throw new Error('shell: invalid pane target');
  await tmux.setPaneOption(target, '@cc_shell', '1');
  return target;
}

/** Run a command line (literal text + Enter) in the session's sister shell. */
export async function shellInput(sessionTarget, cwd, line) {
  const target = await ensureSessionShell(sessionTarget, cwd);
  await tmux.sendText(target, String(line ?? ''));
}

/** Forward literal keystroke text (NO Enter) for raw passthrough typing. */
export async function shellText(sessionTarget, cwd, text) {
  const target = await ensureSessionShell(sessionTarget, cwd);
  await tmux.sendLiteral(target, String(text ?? ''));
}

/** Send one allow-listed control key (e.g. C-c). Throws on anything else. */
export async function shellKey(sessionTarget, cwd, key) {
  if (!SHELL_KEYS.has(key)) throw new Error('key not allowed');
  const target = await ensureSessionShell(sessionTarget, cwd);
  await tmux.sendRawKeys(target, [key]);
}

/** Capture the sister shell pane WITH ANSI escapes for the colored live view. */
export async function shellCapture(sessionTarget, cwd, lines = 200) {
  const target = await ensureSessionShell(sessionTarget, cwd);
  const n = Math.max(1, Math.min(10000, Number(lines) || 200));
  // escapes=true (keep ANSI colors), join=true (rejoin soft-wrapped lines so
  // URLs split across narrow pane columns are reconstructed as single <a> tags).
  return tmux.capturePane(target, n, true, true);
}
